# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

#### `@ikko-dev/shopify-mcp`

- Initial release — HTTP MCP proxy wrapping `@shopify/dev-mcp` (stdio) in a
  Streamable HTTP endpoint for org-wide deployment.
- `ShopifyProxy` — MCP Client + `StdioClientTransport` wrapping the
  `@shopify/dev-mcp` child process with exponential backoff reconnection.
- OAuth 2.1 + PKCE endpoints for Claude Desktop compatibility.
- Tool filtering: `docsOnlyFilter`, `allowList`, `blockList` helpers +
  `SHOPIFY_MCP_DOCS_ONLY` / `SHOPIFY_MCP_ALLOWED_TOOLS` / `SHOPIFY_MCP_BLOCKED_TOOLS`
  environment variables.
- Docker + docker-compose deployment configuration.
