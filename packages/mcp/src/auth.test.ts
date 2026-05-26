import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAccessToken, parseAuthHeader } from "./auth.ts";

describe("parseAuthHeader", () => {
  describe("when MCP_API_KEY is not set (open access)", () => {
    beforeEach(() => {
      vi.stubEnv("MCP_API_KEY", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns { apiKey: "" } for missing header', () => {
      expect(parseAuthHeader(null)).toEqual({ apiKey: "" });
    });

    it('returns { apiKey: "" } for null header', () => {
      expect(parseAuthHeader(null)).toEqual({ apiKey: "" });
    });

    it('returns { apiKey: "" } for any Bearer token', () => {
      expect(parseAuthHeader("Bearer whatever")).toEqual({ apiKey: "" });
    });
  });

  describe("when MCP_API_KEY is set", () => {
    beforeEach(() => {
      vi.stubEnv("MCP_API_KEY", "my-secret-key");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns null for missing header", () => {
      expect(parseAuthHeader(null)).toBeNull();
    });

    it("returns null for null header", () => {
      expect(parseAuthHeader(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseAuthHeader("")).toBeNull();
    });

    it("returns null for non-Bearer scheme", () => {
      expect(parseAuthHeader("Basic dXNlcjpwYXNz")).toBeNull();
    });

    it("returns null for wrong raw key", () => {
      expect(parseAuthHeader("Bearer wrong-key")).toBeNull();
    });

    it("accepts the correct raw API key", () => {
      expect(parseAuthHeader("Bearer my-secret-key")).toEqual({ apiKey: "my-secret-key" });
    });

    it("accepts Bearer with extra whitespace around token (trim is applied)", () => {
      // The regex captures everything after "Bearer\s+", then trim() strips leading/trailing
      // spaces — so double-space still resolves to the correct key
      expect(parseAuthHeader("Bearer  my-secret-key")).toEqual({ apiKey: "my-secret-key" });
    });

    it("is case-insensitive on the Bearer prefix", () => {
      expect(parseAuthHeader("bearer my-secret-key")).toEqual({ apiKey: "my-secret-key" });
      expect(parseAuthHeader("BEARER my-secret-key")).toEqual({ apiKey: "my-secret-key" });
    });

    it("accepts the API key base64url-encoded (OAuth access token)", () => {
      const token = Buffer.from("my-secret-key").toString("base64url");
      expect(parseAuthHeader(`Bearer ${token}`)).toEqual({ apiKey: "my-secret-key" });
    });

    it("returns null for a base64url-encoded wrong key", () => {
      const token = Buffer.from("wrong-key").toString("base64url");
      expect(parseAuthHeader(`Bearer ${token}`)).toBeNull();
    });
  });
});

describe("createAccessToken", () => {
  it("base64url-encodes the api key", () => {
    const token = createAccessToken("my-secret-key");
    expect(Buffer.from(token, "base64url").toString("utf-8")).toBe("my-secret-key");
  });

  it("round-trips through parseAuthHeader", () => {
    vi.stubEnv("MCP_API_KEY", "round-trip-key");
    const token = createAccessToken("round-trip-key");
    expect(parseAuthHeader(`Bearer ${token}`)).toEqual({ apiKey: "round-trip-key" });
    vi.unstubAllEnvs();
  });

  it("produces a different string from the raw key", () => {
    const key = "my-key";
    expect(createAccessToken(key)).not.toBe(key);
  });
});
