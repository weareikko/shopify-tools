/**
 * OAuth 2.1 + PKCE endpoints for the Shopify MCP HTTP server.
 *
 * Stateless — the authorization code carries an AES-256-GCM-encrypted payload
 * with the user's API key and the PKCE challenge. The server keeps nothing.
 *
 * Flow (for Claude Desktop / claude.ai):
 *   1. MCP client redirects user to /authorize with PKCE params
 *   2. User submits the login form with the MCP API key
 *   3. Server encrypts key + challenge into an authorization code, redirects back
 *   4. Client exchanges code for access token at /token (with code_verifier)
 *   5. Server validates PKCE, returns base64url(apiKey) as access_token
 *
 * When MCP_API_KEY is not set, any key is accepted (open access).
 */

import { defineEventHandler, getQuery, readBody, type H3Event } from 'h3';
import { createHash } from 'node:crypto';

import { createAccessToken } from './auth.ts';
import { createAuthCode, decodeAuthCode } from './crypto.ts';

function baseUrl(event: H3Event): string {
  const host = event.req.headers.get('host') ?? 'localhost:3000';
  const proto = event.req.headers.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// OAuth 2.1 discovery endpoints
// ---------------------------------------------------------------------------

export const oauthMetadataHandler = defineEventHandler((event: H3Event) => {
  const url = baseUrl(event);
  event.res.headers.set('Content-Type', 'application/json');
  event.res.headers.set('Cache-Control', 'public, max-age=3600');
  return {
    issuer: url,
    authorization_endpoint: `${url}/authorize`,
    token_endpoint: `${url}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    registration_endpoint: `${url}/register`,
    scopes_supported: ['shopify'],
    service_documentation: 'https://github.com/ikko-dev/shopify-tools',
  };
});

export const protectedResourceHandler = defineEventHandler((event: H3Event) => {
  const url = baseUrl(event);
  event.res.headers.set('Content-Type', 'application/json');
  event.res.headers.set('Cache-Control', 'public, max-age=3600');
  return {
    resource: `${url}/mcp`,
    authorization_servers: [url],
    bearer_methods_supported: ['header'],
    scopes_supported: ['shopify'],
  };
});

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591) — always succeeds, stateless
// ---------------------------------------------------------------------------

export const registerHandler = defineEventHandler(async (event: H3Event) => {
  event.res.headers.set('Content-Type', 'application/json');
  let body: Record<string, unknown> = {};
  try {
    const raw = (await readBody(event)) as unknown;
    body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  } catch {
    event.res.status = 400;
    return { error: 'invalid_request', error_description: 'Invalid JSON body' };
  }
  const clientName = typeof body.client_name === 'string' ? body.client_name : 'MCP Client';
  const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
  const clientId = Buffer.from(JSON.stringify({ name: clientName, ts: Date.now() })).toString(
    'base64url',
  );
  event.res.status = 201;
  return {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
});

// ---------------------------------------------------------------------------
// Authorization endpoint — shows the login form
// ---------------------------------------------------------------------------

export const authorizeGetHandler = defineEventHandler((event: H3Event) => {
  const query = getQuery(event);
  const redirectUri = String(query.redirect_uri ?? '');
  const state = String(query.state ?? '');
  const codeChallenge = String(query.code_challenge ?? '');
  const codeChallengeMethod = String(query.code_challenge_method ?? '');

  event.res.headers.set('Content-Type', 'text/html; charset=utf-8');

  if (!redirectUri) {
    event.res.status = 400;
    return renderErrorPage('Missing required parameter: redirect_uri');
  }

  if (!codeChallenge) {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set('error', 'invalid_request');
    errorUrl.searchParams.set('error_description', 'code_challenge is required (PKCE)');
    if (state) errorUrl.searchParams.set('state', state);
    return Response.redirect(errorUrl.toString(), 302);
  }

  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set('error', 'invalid_request');
    errorUrl.searchParams.set('error_description', 'Only S256 code_challenge_method is supported');
    if (state) errorUrl.searchParams.set('state', state);
    return Response.redirect(errorUrl.toString(), 302);
  }

  return renderLoginForm({
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod: codeChallengeMethod || 'S256',
  });
});

export const authorizePostHandler = defineEventHandler(async (event: H3Event) => {
  const body = ((await readBody(event)) as Record<string, string>) ?? {};
  const { apiKey, redirectUri, state, codeChallenge, codeChallengeMethod } = body;

  event.res.headers.set('Content-Type', 'text/html; charset=utf-8');

  if (!redirectUri) {
    event.res.status = 400;
    return renderErrorPage('Missing redirect_uri parameter');
  }

  // Validate redirect_uri is https or localhost
  try {
    const uri = new URL(redirectUri);
    const isLocalhost = uri.hostname === 'localhost' || uri.hostname === '127.0.0.1';
    const isHttps = uri.protocol === 'https:';
    if (!isLocalhost && !isHttps) {
      event.res.status = 400;
      return renderErrorPage('redirect_uri must be HTTPS or localhost');
    }
  } catch {
    event.res.status = 400;
    return renderErrorPage('Invalid redirect_uri format');
  }

  const expectedKey = process.env.MCP_API_KEY;

  // If auth is disabled and no key provided, generate a dummy token
  const effectiveKey = apiKey?.trim() || '';

  if (expectedKey && effectiveKey !== expectedKey) {
    return renderLoginForm({
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
      error: 'Invalid API key. Please check with your administrator.',
    });
  }

  const code = createAuthCode({
    apiKey: effectiveKey,
    codeChallenge,
    codeChallengeMethod: codeChallengeMethod || 'S256',
  });

  const successUrl = new URL(redirectUri);
  successUrl.searchParams.set('code', code);
  if (state) successUrl.searchParams.set('state', state);

  return Response.redirect(successUrl.toString(), 302);
});

// ---------------------------------------------------------------------------
// Token endpoint — exchanges authorization code for access token
// ---------------------------------------------------------------------------

export const tokenHandler = defineEventHandler(async (event: H3Event) => {
  event.res.headers.set('Content-Type', 'application/json');

  let body: Record<string, string> = {};
  try {
    const raw = (await readBody(event)) as unknown;
    // readBody parses application/x-www-form-urlencoded and application/json
    body = typeof raw === 'object' && raw !== null ? (raw as Record<string, string>) : {};
  } catch {
    event.res.status = 400;
    return { error: 'invalid_request', error_description: 'Invalid request body' };
  }

  const { grant_type, code, code_verifier, refresh_token } = body;

  // Refresh token — we return a new access token with the same API key
  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      event.res.status = 400;
      return { error: 'invalid_request', error_description: 'Missing refresh_token' };
    }
    try {
      const apiKey = Buffer.from(refresh_token, 'base64url').toString('utf-8');
      const accessToken = createAccessToken(apiKey);
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refresh_token, // same refresh token
        scope: 'shopify',
      };
    } catch {
      event.res.status = 400;
      return { error: 'invalid_grant', error_description: 'Invalid refresh_token' };
    }
  }

  // Authorization code exchange
  if (grant_type !== 'authorization_code') {
    event.res.status = 400;
    return {
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code and refresh_token are supported',
    };
  }

  if (!code || !code_verifier) {
    event.res.status = 400;
    return { error: 'invalid_request', error_description: 'Missing code or code_verifier' };
  }

  let payload: { apiKey: string; codeChallenge?: string; codeChallengeMethod?: string };
  try {
    payload = decodeAuthCode(code);
  } catch (err) {
    event.res.status = 400;
    const msg = err instanceof Error ? err.message : 'Invalid authorization code';
    return { error: 'invalid_grant', error_description: msg };
  }

  // Verify PKCE code_verifier
  if (payload.codeChallenge) {
    const verifierHash = createHash('sha256')
      .update(code_verifier)
      .digest('base64url');
    if (verifierHash !== payload.codeChallenge) {
      event.res.status = 400;
      return { error: 'invalid_grant', error_description: 'PKCE code_verifier mismatch' };
    }
  }

  const accessToken = createAccessToken(payload.apiKey);
  // Use the access token itself as the refresh token (stateless)
  const refreshToken = Buffer.from(payload.apiKey).toString('base64url');

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: 'shopify',
  };
});

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Error — Shopify MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #111; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px; }
    h1 { font-size: 1.25rem; color: #dc2626; margin: 0 0 12px; }
    p  { color: #6b7280; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Error</h1>
    <p>${htmlEscape(message)}</p>
  </div>
</body>
</html>`;
}

interface LoginFormParams {
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  error?: string;
}

function renderLoginForm(params: LoginFormParams): string {
  const { redirectUri, state, codeChallenge, codeChallengeMethod, error } = params;
  const authDisabled = !process.env.MCP_API_KEY;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect — Shopify MCP</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f9fafb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      margin: 0;
    }
    .card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06);
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
    }
    .logo svg { width: 32px; height: 32px; }
    .logo-text { font-size: 1.1rem; font-weight: 600; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 6px; }
    .subtitle { color: #6b7280; font-size: .9rem; margin: 0 0 24px; }
    label { display: block; font-size: .875rem; font-weight: 500; margin-bottom: 6px; }
    input[type=password], input[type=text] {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: .95rem;
      outline: none;
      transition: border-color .15s;
    }
    input:focus { border-color: #96bf48; box-shadow: 0 0 0 3px rgba(150,191,72,.15); }
    .hint { color: #9ca3af; font-size: .8rem; margin: 6px 0 0; }
    .error {
      background: #fef2f2; color: #dc2626;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: .875rem;
      margin-bottom: 20px;
    }
    button {
      width: 100%;
      padding: 11px;
      background: #96bf48;
      color: #fff;
      font-size: .95rem;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-top: 20px;
      transition: background .15s;
    }
    button:hover { background: #7ea53b; }
    .open-notice {
      background: #f0fdf4; color: #166534;
      border: 1px solid #bbf7d0;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: .875rem;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <!-- Shopify bag icon (simplified) -->
      <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" rx="6" fill="#96bf48"/>
        <path d="M21 10h-1.5c-.2-1.7-1.5-3-3-3s-2.8 1.3-3 3H12l-2 14h14l-2-14Zm-4.5-1.5c.7 0 1.3.6 1.5 1.5h-3c.2-.9.8-1.5 1.5-1.5Zm0 9a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z" fill="white"/>
      </svg>
      <span class="logo-text">Shopify MCP</span>
    </div>

    <h1>Connect to Shopify MCP</h1>
    <p class="subtitle">
      This server provides MCP access to your Shopify store via
      <code>@shopify/dev-mcp</code>.
    </p>

    ${error ? `<div class="error">${htmlEscape(error)}</div>` : ''}

    ${
      authDisabled
        ? '<div class="open-notice">ℹ️ This server has no API key configured — click Connect to proceed.</div>'
        : ''
    }

    <form method="POST" action="/authorize">
      <input type="hidden" name="redirectUri" value="${htmlEscape(redirectUri)}">
      <input type="hidden" name="state" value="${htmlEscape(state ?? '')}">
      <input type="hidden" name="codeChallenge" value="${htmlEscape(codeChallenge ?? '')}">
      <input type="hidden" name="codeChallengeMethod" value="${htmlEscape(codeChallengeMethod ?? 'S256')}">

      ${
        !authDisabled
          ? `
      <div>
        <label for="apiKey">MCP API Key</label>
        <input
          type="password"
          id="apiKey"
          name="apiKey"
          placeholder="Enter the API key provided by your admin"
          required
          autocomplete="current-password"
        >
        <p class="hint">Contact your administrator if you don't have an API key.</p>
      </div>
      `
          : '<input type="hidden" name="apiKey" value="">'
      }

      <button type="submit">Connect</button>
    </form>
  </div>
</body>
</html>`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
