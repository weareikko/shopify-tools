# shopify-tools

## Overview

HTTP MCP proxy wrapping `@shopify/dev-mcp` (stdio) in a Streamable HTTP endpoint for org-wide deployment.

**Single package:** `packages/mcp` — no api/core/sdk packages since we're proxying, not implementing Shopify API logic ourselves.

## Commands

```bash
npm install               # install all workspace deps
npm run build             # build packages/mcp → dist/
npm run typecheck         # tsc --noEmit across all packages
npm run test              # vitest run
npm run lint              # oxlint
npm run format            # oxfmt --write .
```

## Architecture

```
HTTP clients (Claude Code / claude.ai)
    ↓  MCP Streamable HTTP
packages/mcp/src/server.ts  → HTTP server entry point
packages/mcp/src/http.ts    → StreamableHTTPServerTransport handler
packages/mcp/src/proxy.ts   → ShopifyProxy (MCP Client → @shopify/dev-mcp stdio)
    ↓  @modelcontextprotocol/sdk StdioClientTransport
@shopify/dev-mcp  (child process)
    ↓  Shopify API
Shopify
```

## Key design decisions

- **Proxy pattern**: One shared `ShopifyProxy` instance holds a persistent MCP Client connected to `@shopify/dev-mcp`. All HTTP sessions proxy through it. No Shopify API logic lives in this codebase.
- **Auth**: Simple Bearer API key (`MCP_API_KEY` env var). If unset, server is open (internal use). OAuth 2.1 PKCE for Claude Desktop compatibility — login form asks for the API key.
- **Reconnection**: `ShopifyProxy` auto-reconnects with exponential backoff (max 30s delay, configurable retries).
- **Sessions**: Per-HTTP-client `Server` + `StreamableHTTPServerTransport` pairs managed by `SessionManager` (idle TTL: 30 min).

## Environment variables

| Variable               | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `MCP_API_KEY`          | Pre-shared key for HTTP access (unset = open)                |
| `OAUTH_SECRET`         | AES-256-GCM key for OAuth tokens                             |
| `PORT` / `HOST`        | HTTP bind config                                             |
| `SHOPIFY_FLAG_STORE`   | Store hostname (forwarded to child)                          |
| `SHOPIFY_ACCESS_TOKEN` | Admin API token (forwarded to child)                         |
| `SHOPIFY_MCP_COMMAND`  | Command to start child (default: `npx`)                      |
| `SHOPIFY_MCP_ARGS`     | JSON array of args (default: `["--yes","@shopify/dev-mcp"]`) |

## Conventions

- TypeScript ESM, `"type": "module"`, Node 22+
- Vite builds to `dist/`, vitest for tests
- oxlint + oxfmt for linting/formatting
- `.ts` extensions in imports (requires `allowImportingTsExtensions: true`)
- Commit format: conventional commits (`feat:`, `fix:`, `chore:`, etc.)
