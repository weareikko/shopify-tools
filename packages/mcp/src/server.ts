#!/usr/bin/env node

/**
 * Shopify MCP Server — HTTP Transport (Streamable HTTP)
 *
 * Wraps @shopify/dev-mcp (stdio) in an HTTP MCP endpoint so that the entire
 * organisation can connect to one shared Shopify MCP server from Claude Code,
 * Claude Desktop, or any other MCP-compatible client.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Claude Code / claude.ai / Claude Desktop                   │
 * │       ↓  MCP Streamable HTTP                                │
 * │  shopify-mcp-server  (this binary, port $PORT)              │
 * │       ↓  stdio JSON-RPC (MCP client)                        │
 * │  @shopify/dev-mcp  (child process)                          │
 * │       ↓  Shopify Admin / Partner API                        │
 * │  Shopify                                                    │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Environment variables:
 *
 *   PORT               - HTTP port (default: 3000)
 *   HOST               - Bind address (default: 0.0.0.0)
 *   MCP_API_KEY        - Pre-shared key for HTTP access control.
 *                        When unset, the server accepts all connections
 *                        (suitable for private/internal networks only).
 *   OAUTH_SECRET       - AES-256-GCM key for OAuth token encryption.
 *                        Required in production. A weak default is used if unset.
 *
 *   --- @shopify/dev-mcp child process ---
 *   No store credentials are required. @shopify/dev-mcp exposes only developer
 *   documentation and validation tools (learn_shopify_api, search_docs_chunks,
 *   validate_graphql_codeblocks, validate_component_codeblocks, validate_theme)
 *   without any Shopify store configuration.
 *
 *   If you DO configure a store (SHOPIFY_FLAG_STORE + SHOPIFY_ACCESS_TOKEN),
 *   @shopify/dev-mcp may expose additional store-management tools dynamically.
 *   Use SHOPIFY_MCP_DOCS_ONLY=true to filter those out if you only want docs.
 *
 *   --- Proxy tuning ---
 *   SHOPIFY_MCP_COMMAND    - Override the child command (default: npx)
 *   SHOPIFY_MCP_ARGS       - JSON array of args (default: ["--yes","@shopify/dev-mcp"])
 *   SHOPIFY_MCP_MAX_RETRIES - Max reconnect attempts (default: 10)
 *   SHOPIFY_MCP_DOCS_ONLY  - 'true' → expose only docs/validation tools
 *
 * Usage:
 *   shopify-mcp-server
 *   MCP_API_KEY=secret shopify-mcp-server
 *   PORT=8080 SHOPIFY_FLAG_STORE=my-store.myshopify.com shopify-mcp-server
 *
 * Endpoints:
 *   POST/GET/DELETE /mcp    - MCP Streamable HTTP endpoint
 *   GET  /health            - Health check (includes proxy status)
 *   GET  /                  - Service info
 *
 * OAuth 2.1 endpoints (for Claude Desktop):
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /.well-known/oauth-protected-resource
 *   POST /register
 *   GET  /authorize
 *   POST /authorize
 *   POST /token
 */

import { toNodeHandler } from 'h3/node';
import { createServer, type Server } from 'node:http';

import { createHealthApp, createMcpRequestHandler } from './http.ts';
import { createProxyFromEnv } from './proxy.ts';
import { SessionManager } from './sessions.ts';
import { VERSION } from './version.ts';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';

export interface HttpStartOptions {
  /** Override the port (default: process.env.PORT ?? 3000) */
  port?: number;
  /** Override the bind address (default: process.env.HOST ?? '0.0.0.0') */
  host?: string;
}

/**
 * Start the HTTP server.
 *
 * 1. Creates the ShopifyProxy and connects it to @shopify/dev-mcp.
 * 2. Starts the HTTP server with Streamable HTTP MCP transport + health endpoints.
 * 3. Registers SIGINT / SIGTERM handlers for graceful shutdown.
 */
export async function startHttpServer(options?: HttpStartOptions): Promise<Server> {
  const port = options?.port ?? Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const host = options?.host ?? (process.env.HOST ?? DEFAULT_HOST);

  // --- Proxy ---
  const proxy = createProxyFromEnv();

  console.log('Starting @shopify/dev-mcp child process...');
  await proxy.connect();

  // --- HTTP server ---
  const sessions = new SessionManager();
  const handleMcp = createMcpRequestHandler(sessions, proxy);
  const healthApp = createHealthApp(proxy);
  const healthHandler = toNodeHandler(healthApp);

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const start = Date.now();
    const hasAuth = Boolean(req.headers.authorization);

    res.on('finish', () => {
      console.log(
        `[http] ${req.method} ${url} → ${res.statusCode} ${hasAuth ? '+auth' : ''} (${Date.now() - start}ms)`,
      );
    });

    if (url === '/mcp' || url.startsWith('/mcp?')) {
      await handleMcp(req, res);
      return;
    }

    healthHandler(req, res);
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const display = host === '0.0.0.0' ? 'localhost' : host;
      const authMode = process.env.MCP_API_KEY ? 'API key' : 'open (no MCP_API_KEY set)';

      console.log(`\nShopify MCP server v${VERSION}`);
      console.log(`Node.js ${process.version}`);
      console.log(`Running at http://${display}:${port}`);
      console.log('');
      console.log('Endpoints:');
      console.log(`  POST/GET/DELETE http://${display}:${port}/mcp`);
      console.log(`  GET  http://${display}:${port}/health`);
      console.log('');
      console.log('OAuth 2.1:');
      console.log(`  GET  http://${display}:${port}/authorize`);
      console.log(`  POST http://${display}:${port}/token`);
      console.log('');
      console.log(`Auth: ${authMode}`);
      console.log(`Proxy: ${JSON.stringify(proxy.status)}`);
      console.log('');

      // Graceful shutdown
      const shutdown = async (signal: string) => {
        console.log(`\nReceived ${signal}, shutting down...`);
        server.close();
        await sessions.closeAll();
        await proxy.disconnect();
        console.log('Shutdown complete.');
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

      resolve(server);
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/shopify-mcp-server') ||
  process.argv[1]?.endsWith('\\shopify-mcp-server');

if (isMainModule) {
  startHttpServer().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
