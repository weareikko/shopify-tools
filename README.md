# shopify-tools

Org-wide Shopify MCP server — wraps [`@shopify/dev-mcp`](https://www.npmjs.com/package/@shopify/dev-mcp) (stdio) in an HTTP [MCP Streamable HTTP](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/) endpoint so every team member can connect from Claude Code, claude.ai, or Claude Desktop without running the Shopify CLI locally.

## Packages

| Package | Description |
|---|---|
| [`packages/mcp`](packages/mcp) | HTTP MCP proxy server |

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Configure (copy and fill in the values)
cp .env.example .env

# 4. Run
node packages/mcp/dist/server.js
```

## Docker

```bash
# Build and start with docker compose
docker compose up --build
```

## Connecting from Claude Code

```json
// claude_mcp_config.json  (or ~/.claude/claude_mcp_config.json)
{
  "mcpServers": {
    "shopify": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>"
      }
    }
  }
}
```

For org-level deployment, replace `localhost:3000` with your server's public URL and deploy with HTTPS.

## Architecture

```
Claude Code / claude.ai / Claude Desktop
      ↓  MCP Streamable HTTP
shopify-mcp-server  (HTTP proxy, packages/mcp)
      ↓  stdio JSON-RPC (MCP SDK Client)
@shopify/dev-mcp  (child process, auto-restarted)
      ↓  Shopify Admin / Partner API
Shopify
```

See [`packages/mcp/README.md`](packages/mcp/README.md) for full documentation.

## Development

```bash
npm install
npm run build
npm run test
npm run typecheck
npm run lint
npm run format
```
