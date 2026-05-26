/**
 * CLI flag parsers for the shopify-mcp-server entry point.
 */

export function parseReadOnlyFlag(): boolean {
  return process.argv.includes("--read-only") || process.env.SHOPIFY_MCP_READ_ONLY === "true";
}
