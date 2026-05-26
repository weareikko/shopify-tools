import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthCode, decodeAuthCode, decrypt, encrypt } from "./crypto.ts";

const SECRET = "test-secret-1234567890abcdef";

describe("encrypt / decrypt", () => {
  it("round-trips a plaintext string", () => {
    const ciphertext = encrypt("hello world", SECRET);
    expect(decrypt(ciphertext, SECRET)).toBe("hello world");
  });

  it("produces different ciphertext each time (random IV + salt)", () => {
    const a = encrypt("same", SECRET);
    const b = encrypt("same", SECRET);
    expect(a).not.toBe(b);
  });

  it("throws on wrong secret", () => {
    const ciphertext = encrypt("secret data", SECRET);
    expect(() => decrypt(ciphertext, "wrong-secret")).toThrow("Decryption failed");
  });

  it("throws on tampered ciphertext", () => {
    const ciphertext = encrypt("data", SECRET);
    const tampered = ciphertext.slice(0, -4) + "XXXX";
    expect(() => decrypt(tampered, SECRET)).toThrow();
  });

  it("round-trips unicode content", () => {
    const payload = '{"key":"héllo wörld 🎉"}';
    expect(decrypt(encrypt(payload, SECRET), SECRET)).toBe(payload);
  });
});

describe("createAuthCode / decodeAuthCode", () => {
  beforeEach(() => {
    vi.stubEnv("OAUTH_SECRET", SECRET);
    vi.stubEnv("MCP_API_KEY", "test-api-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips an auth code payload", () => {
    const code = createAuthCode({
      apiKey: "test-api-key",
      codeChallenge: "abc123",
      codeChallengeMethod: "S256",
    });
    const decoded = decodeAuthCode(code);
    expect(decoded.apiKey).toBe("test-api-key");
    expect(decoded.codeChallenge).toBe("abc123");
    expect(decoded.codeChallengeMethod).toBe("S256");
  });

  it("throws on expired code", () => {
    const code = createAuthCode({ apiKey: "k" }, -1); // already expired
    expect(() => decodeAuthCode(code)).toThrow("expired");
  });

  it("throws if apiKey is missing and MCP_API_KEY is set", () => {
    const code = createAuthCode({ apiKey: "" });
    expect(() => decodeAuthCode(code)).toThrow();
  });

  it("does not throw if apiKey is empty and MCP_API_KEY is not set", () => {
    vi.stubEnv("MCP_API_KEY", "");
    const code = createAuthCode({ apiKey: "" });
    expect(() => decodeAuthCode(code)).not.toThrow();
  });
});
