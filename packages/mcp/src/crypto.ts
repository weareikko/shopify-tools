/**
 * AES-256-GCM authenticated encryption for stateless OAuth authorization codes.
 *
 * The authorization code encrypts the PKCE challenge + the API key so the
 * server can stay completely stateless. Only OAUTH_SECRET is needed to decrypt.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

export function getSecret(): string {
  const secret = process.env.OAUTH_SECRET;
  if (!secret) {
    console.warn(
      'WARNING: OAUTH_SECRET not set. Using default secret. Set OAUTH_SECRET in production!',
    );
    return 'shopify-mcp-default-secret-change-me';
  }
  return secret;
}

export function encrypt(plaintext: string, secret: string = getSecret()): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(secret, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64url');
}

export function decrypt(ciphertext: string, secret: string = getSecret()): string {
  try {
    const combined = Buffer.from(ciphertext, 'base64url');
    const salt = combined.subarray(0, SALT_LENGTH);
    const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = combined.subarray(
      SALT_LENGTH + IV_LENGTH,
      SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
    );
    const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

    const key = deriveKey(secret, salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Decryption failed: invalid token or secret');
  }
}

export interface AuthCodePayload {
  /** The MCP API key the user provided */
  apiKey: string;
  /** PKCE code challenge */
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/**
 * Wrap a payload in an encrypted, time-limited authorization code.
 */
export function createAuthCode(payload: AuthCodePayload, expiresInSeconds = 300): string {
  return encrypt(JSON.stringify({ ...payload, exp: Date.now() + expiresInSeconds * 1000 }));
}

/**
 * Decrypt and validate an authorization code.
 */
export function decodeAuthCode(code: string): AuthCodePayload {
  const payload = JSON.parse(decrypt(code)) as AuthCodePayload & { exp?: number };

  if (payload.exp && Date.now() > payload.exp) {
    throw new Error('Authorization code expired');
  }
  if (!payload.apiKey && process.env.MCP_API_KEY) {
    throw new Error('Invalid authorization code: missing apiKey');
  }

  return payload;
}
