# @ikko-dev/shopify-mcp

HTTP MCP proxy that wraps [`@shopify/dev-mcp`](https://www.npmjs.com/package/@shopify/dev-mcp) (stdio) in an MCP Streamable HTTP endpoint, making it available org-wide.

## Architecture

```
Claude Code / claude.ai / Claude Desktop
        ↓  MCP Streamable HTTP (one session per client)
shopify-mcp-server  (this package)
        ↓  stdio JSON-RPC via @modelcontextprotocol/sdk Client
@shopify/dev-mcp  (child process)
        ↓  Shopify Admin / Partner API
Shopify
```

One `@shopify/dev-mcp` process is shared across all HTTP sessions. The proxy reconnects automatically with exponential back-off if the child process crashes.

## Quick start

```bash
npm install
npm run build -w @ikko-dev/shopify-mcp

# Run with a Shopify store:
MCP_API_KEY=my-secret \
SHOPIFY_FLAG_STORE=my-store.myshopify.com \
SHOPIFY_ACCESS_TOKEN=shpat_... \
node packages/mcp/dist/server.js
```

## Tools exposed

`@shopify/dev-mcp` v1.x exposes these tools **without any store credentials**:

| Tool | Description |
|---|---|
| `learn_shopify_api` | Load documentation context for a Shopify API surface (Admin, Storefront, Functions, Liquid, Polaris, Hydrogen, …) |
| `search_docs_chunks` | Search shopify.dev documentation |
| `validate_graphql_codeblocks` | Validate GraphQL against Shopify schemas (Admin, Storefront, Partner, Functions, …) |
| `validate_component_codeblocks` | Validate Polaris / UI extension component code |
| `validate_theme` | Validate Liquid theme files |

No Shopify store or API credentials are needed for any of these.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MCP_API_KEY` | ✗ | Pre-shared key for HTTP access control. When unset, all connections are accepted (internal networks only). |
| `OAUTH_SECRET` | ✗ (prod: ✓) | AES-256-GCM key for OAuth token encryption. |
| `PORT` | ✗ | HTTP port (default: `3000`) |
| `HOST` | ✗ | Bind address (default: `0.0.0.0`) |

### Shopify store credentials (optional)

Not required for dev-docs tools. Set only if you want store-management tools:

| Variable | Description |
|---|---|
| `SHOPIFY_FLAG_STORE` | Store hostname, e.g. `my-store.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Admin API access token (`shpat_...`) |

### Proxy tuning

| Variable | Default | Description |
|---|---|---|
| `SHOPIFY_MCP_COMMAND` | `npx` | Command to start the child |
| `SHOPIFY_MCP_ARGS` | `["--yes","@shopify/dev-mcp"]` | JSON array of args |
| `SHOPIFY_MCP_MAX_RETRIES` | `10` | Max reconnect attempts |
| `SHOPIFY_MCP_DOCS_ONLY` | — | `true` → hide store tools if a store is configured |

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST/GET/DELETE | `/mcp` | MCP Streamable HTTP endpoint |
| GET | `/health` | Health check (includes proxy status) |
| GET | `/` | Service info |
| GET | `/.well-known/oauth-authorization-server` | OAuth 2.1 metadata |
| GET | `/authorize` | OAuth login form |
| POST | `/token` | Token exchange |

## Connecting from Claude Code

Add to your Claude Code MCP config (or org-level MCP config):

```json
{
  "mcpServers": {
    "shopify": {
      "type": "http",
      "url": "https://shopify-mcp.your-org.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>"
      }
    }
  }
}
```

### Claude Desktop (OAuth 2.1)

Claude Desktop uses OAuth 2.1 PKCE automatically. Point it at the server URL and it will open the `/authorize` page where users enter the `MCP_API_KEY`.

## Docker deployment

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY packages/mcp/dist ./dist
COPY packages/mcp/package.json .

# @shopify/dev-mcp is installed at runtime via npx (default) or pre-install it:
# RUN npm install @shopify/dev-mcp

ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000
CMD ["node", "dist/server.js"]
```

```yaml
# docker-compose.yml
services:
  shopify-mcp:
    build: .
    ports:
      - "3000:3000"
    environment:
      MCP_API_KEY: "${MCP_API_KEY}"
      OAUTH_SECRET: "${OAUTH_SECRET}"
      SHOPIFY_FLAG_STORE: "${SHOPIFY_FLAG_STORE}"
      SHOPIFY_ACCESS_TOKEN: "${SHOPIFY_ACCESS_TOKEN}"
    restart: unless-stopped
```

## Development

```bash
npm install
npm run build -w @ikko-dev/shopify-mcp
npm run test -w @ikko-dev/shopify-mcp
npm run typecheck
```
