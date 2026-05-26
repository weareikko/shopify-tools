/* eslint-disable typescript-eslint/no-deprecated -- low-level Server for StreamableHTTPServerTransport */

/**
 * Streamable HTTP transport for the Shopify MCP proxy server.
 *
 * Implements the MCP Streamable HTTP transport (2025-03-26 spec).
 *
 * Architecture:
 * - One shared ShopifyProxy (MCP Client ↔ @shopify/dev-mcp stdio process)
 * - Per-session MCP Server instances (one per HTTP client)
 * - All tool calls are forwarded through the shared proxy — no Shopify API
 *   logic lives here
 * - Auth: Bearer token validated against MCP_API_KEY env var (or open if unset)
 * - OAuth 2.1 endpoints handled by h3 (see oauth.ts)
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// eslint-disable-next-line typescript-eslint/no-deprecated
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { H3, defineEventHandler } from 'h3';

import { parseAuthHeader } from './auth.ts';
import {
  authorizeGetHandler,
  authorizePostHandler,
  oauthMetadataHandler,
  protectedResourceHandler,
  registerHandler,
  tokenHandler,
} from './oauth.ts';
import type { ShopifyProxy } from './proxy.ts';
import { SessionManager } from './sessions.ts';
import { VERSION } from './version.ts';

export { SessionManager } from './sessions.ts';

// ---------------------------------------------------------------------------
// MCP Server factory — one per HTTP session
// ---------------------------------------------------------------------------

/**
 * Create a per-session MCP Server that proxies all tool calls through
 * the shared ShopifyProxy instance.
 *
 * The server is intentionally lightweight: it holds no Shopify state itself.
 * Every list/call is forwarded to the proxy which talks to @shopify/dev-mcp.
 */
function createMcpServer(proxy: ShopifyProxy): Server {
  // eslint-disable-next-line typescript-eslint/no-deprecated
  const server = new Server(
    { name: 'shopify-mcp', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'This server provides MCP access to a Shopify store via @shopify/dev-mcp.',
        'Use the available tools to query and manage products, orders, customers,',
        'inventory, discounts, collections, and more through the Shopify Admin API.',
        '',
        'All operations go through a pre-configured Shopify store.',
        'Contact your administrator for store-level access or permissions.',
      ].join('\n'),
    },
  );

  // List tools — delegate to proxy (cached after first call)
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const tools = await proxy.listTools();
      return { tools };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list tools from @shopify/dev-mcp: ${message}`);
    }
  });

  // Call tool — proxy to @shopify/dev-mcp
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await proxy.callTool(name, args ?? {});
      return result as CallToolResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        structuredContent: { success: false, error: message },
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Per-request MCP handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming MCP HTTP request.
 *
 * Routes:
 *   No session ID + initialize → create new session
 *   Has session ID → route to existing session
 *
 * Auth is validated on every request. Credentials are not stored server-side;
 * the Bearer token is validated per-request against MCP_API_KEY.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  proxy: ShopifyProxy,
): Promise<void> {
  // --- Auth ---
  const authHeader = req.headers.authorization;
  const auth = parseAuthHeader(authHeader);

  if (!auth) {
    const host = req.headers.host ?? 'localhost:3000';
    const proto = req.headers['x-forwarded-proto'];
    const protocol = (typeof proto === 'string' ? proto : undefined) ?? 'http';
    const resourceMetadataUrl = `${protocol}://${host}/.well-known/oauth-protected-resource`;

    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
    });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'Authentication required. Provide a Bearer token (MCP API key). ' +
            'Visit /authorize to obtain an OAuth access token.',
        },
        id: null,
      }),
    );
    return;
  }

  // Stash auth info for downstream handlers (MCP SDK forwards `auth` as extra.authInfo)
  Object.assign(req, {
    auth: {
      token: auth.apiKey,
      clientId: 'shopify-http-client',
      scopes: ['shopify'],
      extra: {},
    },
  });

  // --- Session routing ---
  const sessionHeader = req.headers['mcp-session-id'];
  const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Session not found. It may have expired or been terminated.',
          },
          id: null,
        }),
      );
      return;
    }
    await session.transport.handleRequest(req, res);
    return;
  }

  // --- New session ---
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createMcpServer(proxy);
  await server.connect(transport);

  // eslint-disable-next-line unicorn/prefer-add-event-listener -- SDK uses property assignment
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      sessions.remove(sid).catch(() => {});
    }
  };

  await transport.handleRequest(req, res);

  if (transport.sessionId) {
    sessions.register(transport, server);
  } else {
    // Initialize failed — clean up immediately
    await transport.close();
    await server.close();
  }
}

/**
 * Bound handler factory (convenience for server.ts).
 */
export function createMcpRequestHandler(
  sessions: SessionManager,
  proxy: ShopifyProxy,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return (req, res) => handleMcpRequest(req, res, sessions, proxy);
}

// ---------------------------------------------------------------------------
// Health / info app (h3)
// ---------------------------------------------------------------------------

/**
 * Create the h3 app for health checks, service info, and OAuth endpoints.
 * The /mcp route is handled separately by handleMcpRequest above.
 */
export function createHealthApp(proxy: ShopifyProxy): H3 {
  const app = new H3();

  app.get(
    '/',
    defineEventHandler(() => ({
      status: 'ok',
      service: 'shopify-mcp',
      version: VERSION,
      proxy: proxy.status,
    })),
  );

  app.get(
    '/health',
    defineEventHandler(() => {
      const { connected } = proxy.status;
      return {
        status: connected ? 'ok' : 'degraded',
        proxy: proxy.status,
      };
    }),
  );

  // OAuth 2.1 endpoints (RFC 8414, RFC 9728, RFC 7591)
  app.get('/.well-known/oauth-authorization-server', oauthMetadataHandler);
  app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  app.post('/register', registerHandler);
  app.get('/authorize', authorizeGetHandler);
  app.post('/authorize', authorizePostHandler);
  app.post('/token', tokenHandler);

  return app;
}
