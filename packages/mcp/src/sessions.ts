/* eslint-disable typescript-eslint/no-deprecated -- low-level Server type for session management */

/**
 * Session manager for multi-tenant Streamable HTTP transport.
 *
 * Each MCP client session gets its own transport + server pair. Sessions are
 * identified by UUID and tracked in a Map. Idle sessions are reaped after a
 * configurable TTL.
 */

// eslint-disable-next-line typescript-eslint/no-deprecated
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionManagerOptions {
  /** Idle TTL in ms. Default 30 minutes; 0 disables reaping. */
  ttl?: number;
  /** How often to check for expired sessions, in ms. Default 60s. */
  sweepInterval?: number;
}

const DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes
const DEFAULT_SWEEP_INTERVAL = 60 * 1000; // 1 minute

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly ttl: number;

  constructor(options?: SessionManagerOptions) {
    this.ttl = options?.ttl ?? DEFAULT_TTL;
    if (this.ttl > 0) {
      const interval = options?.sweepInterval ?? DEFAULT_SWEEP_INTERVAL;
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      this.sweepTimer.unref();
    }
  }

  register(transport: StreamableHTTPServerTransport, server: Server): void {
    const id = transport.sessionId;
    if (id) {
      const now = Date.now();
      this.sessions.set(id, { transport, server, createdAt: now, lastActiveAt: now });
    }
  }

  get(id: string): ManagedSession | undefined {
    const session = this.sessions.get(id);
    if (session) session.lastActiveAt = Date.now();
    return session;
  }

  async remove(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      this.sessions.delete(id);
      await s.transport.close();
      await s.server.close();
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  sweep(): number {
    if (this.ttl <= 0) return 0;
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, s] of this.sessions) {
      if (now - s.lastActiveAt > this.ttl) expired.push(id);
    }
    for (const id of expired) {
      this.remove(id).catch(() => {});
    }
    return expired.length;
  }

  async closeAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const promises: Promise<void>[] = [];
    for (const [, s] of this.sessions) {
      promises.push(s.transport.close());
      promises.push(s.server.close());
    }
    await Promise.all(promises);
    this.sessions.clear();
  }
}
