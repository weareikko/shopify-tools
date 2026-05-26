import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionManager } from "./sessions.ts";
import type { ManagedSession } from "./sessions.ts";

// ---------------------------------------------------------------------------
// Helpers — create minimal mock sessions
// ---------------------------------------------------------------------------

function makeTransport(id = `t-${Math.random().toString(36).slice(2)}`) {
  return {
    sessionId: id,
    close: vi.fn().mockResolvedValue(null),
    onclose: null,
    handleRequest: vi.fn(),
  } as unknown as ManagedSession["transport"];
}

function makeServer() {
  return {
    close: vi.fn().mockResolvedValue(null),
  } as unknown as ManagedSession["server"];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  let mgr: SessionManager;

  beforeEach(() => {
    // Disable the automatic sweep timer in tests
    mgr = new SessionManager({ ttl: 0 });
  });

  afterEach(async () => {
    await mgr.closeAll();
  });

  describe("register / get", () => {
    it("registers a session and retrieves it by id", () => {
      const transport = makeTransport("abc");
      const server = makeServer();
      mgr.register(transport, server);
      const session = mgr.get("abc");
      expect(session).toBeDefined();
      expect(session?.transport).toBe(transport);
      expect(session?.server).toBe(server);
    });

    it("returns undefined for unknown session id", () => {
      expect(mgr.get("no-such-id")).toBeUndefined();
    });

    it("does nothing when transport.sessionId is falsy", () => {
      const transport = makeTransport("");
      mgr.register(transport, makeServer());
      expect(mgr.size).toBe(0);
    });

    it("updates lastActiveAt on get", async () => {
      const transport = makeTransport("xyz");
      mgr.register(transport, makeServer());
      const before = mgr.get("xyz")!.lastActiveAt;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      const after = mgr.get("xyz")!.lastActiveAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe("remove", () => {
    it("removes the session and closes transport + server", async () => {
      const transport = makeTransport("del");
      const server = makeServer();
      mgr.register(transport, server);
      await mgr.remove("del");
      expect(mgr.get("del")).toBeUndefined();
      expect(transport.close).toHaveBeenCalledOnce();
      expect(server.close).toHaveBeenCalledOnce();
    });

    it("is a no-op for unknown id", async () => {
      await expect(mgr.remove("ghost")).resolves.toBeUndefined();
    });
  });

  describe("size", () => {
    it("tracks the number of sessions", () => {
      expect(mgr.size).toBe(0);
      mgr.register(makeTransport("a"), makeServer());
      expect(mgr.size).toBe(1);
      mgr.register(makeTransport("b"), makeServer());
      expect(mgr.size).toBe(2);
    });
  });

  describe("sweep", () => {
    it("removes sessions past their TTL", async () => {
      const sweepMgr = new SessionManager({ ttl: 10, sweepInterval: 100_000 });
      const transport = makeTransport("old");
      sweepMgr.register(transport, makeServer());

      // Back-date lastActiveAt so it looks stale
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = (sweepMgr as any).sessions.get("old") as ManagedSession;
      session.lastActiveAt = Date.now() - 200;

      const removed = sweepMgr.sweep();
      expect(removed).toBe(1);
      expect(sweepMgr.size).toBe(0);

      await sweepMgr.closeAll();
    });

    it("returns 0 when ttl is 0 (disabled)", () => {
      // mgr has ttl=0
      mgr.register(makeTransport("s"), makeServer());
      expect(mgr.sweep()).toBe(0);
      expect(mgr.size).toBe(1);
    });
  });

  describe("closeAll", () => {
    it("closes all sessions and clears the map", async () => {
      const t1 = makeTransport("s1");
      const t2 = makeTransport("s2");
      const srv1 = makeServer();
      const srv2 = makeServer();
      mgr.register(t1, srv1);
      mgr.register(t2, srv2);

      await mgr.closeAll();

      expect(mgr.size).toBe(0);
      expect(t1.close).toHaveBeenCalledOnce();
      expect(t2.close).toHaveBeenCalledOnce();
      expect(srv1.close).toHaveBeenCalledOnce();
      expect(srv2.close).toHaveBeenCalledOnce();
    });
  });
});
