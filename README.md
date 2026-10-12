# shopify-tools

Org-wide Shopify MCP server — wraps [`@shopify/dev-mcp`](https://www.npmjs.com/package/@shopify/dev-mcp) (stdio) in an HTTP [MCP Streamable HTTP](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/) endpoint so every team member can connect from Claude Code, claude.ai, or Claude Desktop without running the Shopify CLI locally.

## Packages

| Package                        | Description           |
| ------------------------------ | --------------------- |
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

## Changelog and releases

Do not edit `CHANGELOG.md`. Each pull request adds a fragment in `.changelog/<slug>.md` with `###` Keep a Changelog sections, without the pull request number (the release adds it). A pull request that changes `packages/` or the `Dockerfile` needs a fragment, unless it has the `no-changelog` label. See [`weareikko/changelog`](https://github.com/weareikko/changelog) for the format.

Maintainers release with the `Release` workflow, which runs the checks, bumps the version, folds the fragments into `CHANGELOG.md`, tags, publishes to npm and creates the GitHub release:

```bash
gh workflow run publish.yml -f version=patch   # or minor, major, prerelease, or an exact version such as 0.1.0
```
