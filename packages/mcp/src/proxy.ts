/**
 * ShopifyProxy — bridges the HTTP MCP server to the @shopify/dev-mcp child process.
 *
 * Architecture:
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  HTTP MCP Clients (Claude Code / claude.ai)                      │
 * │       ↓  MCP Streamable HTTP (one session per client)            │
 * │  shopify-mcp-server  (this package, packages/mcp)                │
 * │       ↓  @modelcontextprotocol/sdk Client + StdioClientTransport │
 * │  @shopify/dev-mcp  (child process, stdio JSON-RPC)               │
 * │       ↓  Shopify Admin API / Partner API                         │
 * │  Shopify                                                         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * One shared proxy instance is created at server startup and reused for all
 * HTTP sessions — tool calls are routed through the single MCP Client and are
 * safe to make concurrently (the SDK handles request/response correlation by id).
 *
 * If the @shopify/dev-mcp process crashes, the proxy reconnects automatically
 * with exponential back-off (configurable, capped at 30 s).
 *
 * Shopify credentials (store URL, access token, etc.) are configured once via
 * environment variables and passed to the child process. See README for the
 * full list of supported variables.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { VERSION } from './version.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShopifyProxyOptions {
  /**
   * Executable used to launch @shopify/dev-mcp.
   *
   * Default: 'npx'
   *
   * Alternatives:
   *   - 'node' with args: ['node_modules/@shopify/dev-mcp/dist/index.js']
   *   - '/path/to/shopify-dev-mcp' (pre-installed binary)
   */
  command?: string;

  /**
   * Arguments passed to the command.
   *
   * Default: ['--yes', '@shopify/dev-mcp']
   *
   * If @shopify/dev-mcp is already installed locally, use:
   *   args: ['node_modules/@shopify/dev-mcp/dist/index.js']
   * with command: 'node'
   */
  args?: string[];

  /**
   * Additional environment variables merged on top of process.env for the
   * child process. Use this to pass Shopify credentials:
   *
   *   env: {
   *     SHOPIFY_FLAG_STORE: 'my-store.myshopify.com',
   *     SHOPIFY_ACCESS_TOKEN: 'shpat_...',
   *   }
   *
   * When omitted, SHOPIFY_* variables already present in process.env are
   * forwarded automatically (they are part of the inherited environment).
   */
  env?: NodeJS.ProcessEnv;

  /** Maximum reconnect attempts after a crash. Default: 10 */
  maxRetries?: number;

  /** Initial reconnect delay in ms (doubles each attempt). Default: 1 000 */
  initialRetryDelayMs?: number;

  /** Hard cap on reconnect delay in ms. Default: 30 000 */
  maxRetryDelayMs?: number;
}

export interface ProxyStatus {
  connected: boolean;
  toolCount: number;
  retryCount: number;
}

// ---------------------------------------------------------------------------
// ShopifyProxy
// ---------------------------------------------------------------------------

export class ShopifyProxy {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private toolsCache: Tool[] | null = null;

  private connected = false;
  private retryCount = 0;
  private retryDelayMs: number;
  private stopping = false;

  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly initialRetryDelayMs: number;

  constructor(options: ShopifyProxyOptions = {}) {
    this.command = options.command ?? 'npx';
    this.args = options.args ?? ['--yes', '@shopify/dev-mcp'];
    this.env = options.env ?? {};
    this.maxRetries = options.maxRetries ?? 10;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.retryDelayMs = this.initialRetryDelayMs;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the @shopify/dev-mcp child process and connect the MCP Client.
   * Rejects if the initial connection fails.
   */
  async connect(): Promise<void> {
    this.stopping = false;
    await this._doConnect();
  }

  /**
   * Gracefully disconnect. Does NOT restart.
   */
  async disconnect(): Promise<void> {
    this.stopping = true;
    await this._teardown();
  }

  // ---------------------------------------------------------------------------
  // Public API used by http.ts
  // ---------------------------------------------------------------------------

  /**
   * Return the tool list from @shopify/dev-mcp.
   * Results are cached after the first call; the cache is invalidated on reconnect.
   */
  async listTools(): Promise<Tool[]> {
    this._assertConnected();
    if (!this.toolsCache) {
      await this._refreshTools();
    }
    return this.toolsCache ?? [];
  }

  /**
   * Call a tool on @shopify/dev-mcp and return its result.
   * Safe to call concurrently — the SDK handles request ID correlation.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this._assertConnected();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted above
    return this.client!.callTool({ name, arguments: args });
  }

  get status(): ProxyStatus {
    return {
      connected: this.connected,
      toolCount: this.toolsCache?.length ?? 0,
      retryCount: this.retryCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _assertConnected(): void {
    if (!this.connected || !this.client) {
      throw new Error(
        'ShopifyProxy is not connected. The @shopify/dev-mcp process may still be starting or has crashed.',
      );
    }
  }

  private async _doConnect(): Promise<void> {
    // Build the child env: inherit everything from process.env, then overlay
    // any caller-supplied overrides. SHOPIFY_* variables in the parent env
    // are automatically included this way.
    // StdioClientTransport wants Record<string, string> — filter out undefined values
    const childEnv: Record<string, string> = Object.fromEntries(
      Object.entries({ ...process.env, ...this.env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: childEnv,
      // Capture stderr so we can prefix it and forward to our own stderr.
      // Use 'inherit' if you want raw output; 'pipe' lets us annotate lines.
      stderr: 'pipe',
    });

    // Forward annotated stderr from the child
    if (this.transport.stderr) {
      this.transport.stderr.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) console.error(`[shopify-dev-mcp] ${line}`);
        }
      });
    }

    // Reconnect when the child exits
    this.transport.onclose = () => {
      if (this.stopping) return;
      console.error('[proxy] @shopify/dev-mcp process closed unexpectedly.');
      this.connected = false;
      this._scheduleReconnect();
    };

    this.transport.onerror = (error: Error) => {
      console.error(`[proxy] Transport error: ${error.message}`);
    };

    this.client = new Client(
      { name: 'shopify-mcp-proxy', version: VERSION },
      // Empty capabilities object — the Client will negotiate what the server
      // supports during the initialize handshake. We discover tools via listTools().
      { capabilities: {} },
    );

    // This spawns the child process and performs the MCP initialize handshake
    await this.client.connect(this.transport);

    this.connected = true;
    this.retryCount = 0;
    this.retryDelayMs = this.initialRetryDelayMs; // reset backoff

    // Pre-warm the tools cache so the first listTools() call is instant
    await this._refreshTools();

    console.error(
      `[proxy] Connected to @shopify/dev-mcp (${this.toolsCache?.length ?? 0} tool(s) available)`,
    );
  }

  private async _refreshTools(): Promise<void> {
    if (!this.client) return;
    const result = await this.client.listTools();
    this.toolsCache = result.tools;
  }

  private async _teardown(): Promise<void> {
    this.connected = false;
    this.toolsCache = null;

    try {
      if (this.transport) {
        await this.transport.close();
      }
    } catch {
      // Ignore teardown errors
    }

    this.client = null;
    this.transport = null;
  }

  private _scheduleReconnect(): void {
    if (this.stopping) return;

    if (this.retryCount >= this.maxRetries) {
      console.error(
        `[proxy] Reached max retries (${this.maxRetries}). Giving up reconnecting to @shopify/dev-mcp.`,
      );
      return;
    }

    const delay = this.retryDelayMs;
    // Exponential back-off: double each time, capped at maxRetryDelayMs
    this.retryDelayMs = Math.min(delay * 2, this.maxRetryDelayMs);
    this.retryCount++;

    console.error(
      `[proxy] Reconnecting in ${delay}ms (attempt ${this.retryCount}/${this.maxRetries})...`,
    );

    setTimeout(async () => {
      if (this.stopping) return;
      try {
        await this._doConnect();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[proxy] Reconnection attempt ${this.retryCount} failed: ${msg}`);
        this._scheduleReconnect();
      }
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// Factory — creates and connects the singleton proxy used by http.ts
// ---------------------------------------------------------------------------

/**
 * Build proxy options from environment variables.
 *
 * Environment variables:
 *   SHOPIFY_MCP_COMMAND    - Override the command (default: 'npx')
 *   SHOPIFY_MCP_ARGS       - JSON array of args (default: '["--yes","@shopify/dev-mcp"]')
 *   SHOPIFY_MCP_MAX_RETRIES - Max reconnect attempts (default: 10)
 *
 * Shopify credentials are read from the environment automatically (process.env
 * is fully inherited by the child). Key variables for @shopify/dev-mcp:
 *   SHOPIFY_FLAG_STORE       - Store hostname, e.g. my-store.myshopify.com
 *   SHOPIFY_ACCESS_TOKEN     - Admin API access token (shpat_...)
 *   SHOPIFY_CLI_PARTNERS_TOKEN - Partner API token (for partner-level access)
 */
export function createProxyFromEnv(): ShopifyProxy {
  const command = process.env.SHOPIFY_MCP_COMMAND ?? 'npx';

  let args: string[] = ['--yes', '@shopify/dev-mcp'];
  if (process.env.SHOPIFY_MCP_ARGS) {
    try {
      const parsed: unknown = JSON.parse(process.env.SHOPIFY_MCP_ARGS);
      if (Array.isArray(parsed) && parsed.every((a) => typeof a === 'string')) {
        args = parsed as string[];
      }
    } catch {
      console.warn('[proxy] SHOPIFY_MCP_ARGS is not valid JSON, using default args');
    }
  }

  const maxRetries = process.env.SHOPIFY_MCP_MAX_RETRIES
    ? Number.parseInt(process.env.SHOPIFY_MCP_MAX_RETRIES, 10)
    : undefined;

  return new ShopifyProxy({ command, args, maxRetries });
}
