/**
 * Authentication for the Shopify MCP HTTP server.
 *
 * Unlike Ghost/Forge tools where each user provides their own credentials,
 * the Shopify MCP proxy uses a single pre-configured Shopify store (via env
 * vars at startup). HTTP access is protected by a pre-shared API key.
 *
 * Bearer token formats accepted:
 *  1. Raw API key:     `Authorization: Bearer <MCP_API_KEY>`
 *  2. OAuth token:     `Authorization: Bearer base64url(<MCP_API_KEY>)` (from OAuth flow)
 *  3. No auth:         all requests accepted when MCP_API_KEY is not set
 *
 * For Claude Desktop / claude.ai (which use OAuth 2.1), users enter the
 * MCP_API_KEY in the /authorize login form. The resulting access token is
 * just base64url-encoded key, so validation stays stateless.
 */

export interface AuthResult {
  apiKey: string;
}

/**
 * Validate an Authorization header and return the API key if valid.
 *
 * Returns null on auth failure (caller should respond 401).
 * Returns { apiKey: '' } when auth is disabled (MCP_API_KEY not set).
 */
export function parseAuthHeader(header: string | undefined | null): AuthResult | null {
  const expectedKey = process.env.MCP_API_KEY;

  // Auth disabled — anyone can connect (useful for internal/local deployments)
  if (!expectedKey) {
    return { apiKey: "" };
  }

  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;

  const token = match[1].trim();
  if (!token) return null;

  // Accept raw API key
  if (token === expectedKey) {
    return { apiKey: token };
  }

  // Accept base64url-encoded API key (produced by the OAuth flow)
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    if (decoded === expectedKey) {
      return { apiKey: decoded };
    }
  } catch {
    // Not valid base64 — fall through
  }

  return null;
}

/**
 * Encode the API key as a base64url string for use as an OAuth access token.
 * Stateless — the server only needs to decode and compare against MCP_API_KEY.
 */
export function createAccessToken(apiKey: string): string {
  return Buffer.from(apiKey).toString("base64url");
}
