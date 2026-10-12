### Added

- Initial release — HTTP MCP proxy wrapping `@shopify/dev-mcp` (stdio) in a Streamable HTTP endpoint for org-wide deployment. [[915f084]]
- `ShopifyProxy` — MCP Client + `StdioClientTransport` wrapping the `@shopify/dev-mcp` child process with exponential backoff reconnection. [[915f084]]
- OAuth 2.1 + PKCE endpoints for Claude Desktop compatibility. [[915f084]]
- Tool filtering: `docsOnlyFilter`, `allowList`, `blockList` helpers + `SHOPIFY_MCP_DOCS_ONLY` / `SHOPIFY_MCP_ALLOWED_TOOLS` / `SHOPIFY_MCP_BLOCKED_TOOLS` environment variables. [[42b0b9b]]
- Docker + docker-compose deployment configuration. [[915f084]]

[915f084]: https://github.com/weareikko/shopify-tools/commit/915f08406c5a249f13f5aebfa24314c56fd11142
[42b0b9b]: https://github.com/weareikko/shopify-tools/commit/42b0b9be1530e52f7eeb386d723bb5d78a487677
