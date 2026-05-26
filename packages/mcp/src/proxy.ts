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

  /**
   * Optional filter applied to every tool returned by @shopify/dev-mcp.
   *
   * Return `true` to expose the tool, `false` to hide it.
   * Filtered tools are invisible to HTTP clients AND calls to them are blocked
   * with a clear error (prevents bypassing via direct JSON-RPC).
   *
   * Use the built-in `docsOnlyFilter` or build your own from `allowList` /
   * `blockList` helpers exported below.
   *
   * @example — docs & schema only
   *   import { docsOnlyFilter } from './proxy.ts';
   *   new ShopifyProxy({ toolFilter: docsOnlyFilter })
   *
   * @example — custom allowlist
   *   import { allowList } from './proxy.ts';
   *   new ShopifyProxy({ toolFilter: allowList(['search_dev_docs', 'introspect_admin_schema']) })
   */
  toolFilter?: (tool: Tool) => boolean;
}

export interface ProxyStatus {
  connected: boolean;
  toolCount: number;
  filteredToolCount: number;
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
  private readonly toolFilter: ((tool: Tool) => boolean) | undefined;

  constructor(options: ShopifyProxyOptions = {}) {
    this.command = options.command ?? 'npx';
    this.args = options.args ?? ['--yes', '@shopify/dev-mcp'];
    this.env = options.env ?? {};
    this.maxRetries = options.maxRetries ?? 10;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.retryDelayMs = this.initialRetryDelayMs;
    this.toolFilter = options.toolFilter;
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
   * Return the (filtered) tool list from @shopify/dev-mcp.
   * Results are cached after the first call; the cache is invalidated on reconnect.
   */
  async listTools(): Promise<Tool[]> {
    this._assertConnected();
    if (!this.toolsCache) {
      await this._refreshTools();
    }
    const all = this.toolsCache ?? [];
    return this.toolFilter ? all.filter(this.toolFilter) : all;
  }

  /**
   * Call a tool on @shopify/dev-mcp and return its result.
   * Calls to filtered-out tools are rejected before reaching the child process.
   * Safe to call concurrently — the SDK handles request ID correlation.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this._assertConnected();

    // Guard: reject calls to tools that were filtered out of listTools()
    if (this.toolFilter) {
      const tool = (this.toolsCache ?? []).find((t) => t.name === name);
      if (tool && !this.toolFilter(tool)) {
        throw new Error(
          `Tool "${name}" is not available on this server (disabled by server policy).`,
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted above
    return this.client!.callTool({ name, arguments: args });
  }

  get status(): ProxyStatus {
    const all = this.toolsCache ?? [];
    const visible = this.toolFilter ? all.filter(this.toolFilter) : all;
    return {
      connected: this.connected,
      toolCount: visible.length,
      filteredToolCount: all.length - visible.length,
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

    const all = this.toolsCache?.length ?? 0;
    const visible = this.toolFilter ? (this.toolsCache ?? []).filter(this.toolFilter).length : all;
    const filterNote = this.toolFilter ? `, ${all - visible} hidden by filter` : '';
    console.error(
      `[proxy] Connected to @shopify/dev-mcp (${visible} tool(s) available${filterNote})`,
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
 *   SHOPIFY_MCP_COMMAND       - Override the command (default: 'npx')
 *   SHOPIFY_MCP_ARGS          - JSON array of args (default: '["--yes","@shopify/dev-mcp"]')
 *   SHOPIFY_MCP_MAX_RETRIES   - Max reconnect attempts (default: 10)
 *   SHOPIFY_MCP_DOCS_ONLY     - 'true' → expose only developer docs / schema tools
 *   SHOPIFY_MCP_ALLOWED_TOOLS - Comma-separated exact tool names to expose
 *                               (overrides SHOPIFY_MCP_DOCS_ONLY)
 *   SHOPIFY_MCP_BLOCKED_TOOLS - Comma-separated exact tool names to hide
 *                               (cannot be combined with ALLOWED_TOOLS)
 *
 * Shopify credentials are read from the environment automatically (process.env
 * is fully inherited by the child). Key variables for @shopify/dev-mcp:
 *   SHOPIFY_FLAG_STORE         - Store hostname, e.g. my-store.myshopify.com
 *   SHOPIFY_ACCESS_TOKEN       - Admin API access token (shpat_...)
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

  const toolFilter = resolveToolFilterFromEnv();

  return new ShopifyProxy({ command, args, maxRetries, toolFilter });
}

/**
 * Resolve the tool filter from environment variables.
 * Priority: SHOPIFY_MCP_ALLOWED_TOOLS > SHOPIFY_MCP_BLOCKED_TOOLS > SHOPIFY_MCP_DOCS_ONLY
 */
function resolveToolFilterFromEnv(): ((tool: Tool) => boolean) | undefined {
  if (process.env.SHOPIFY_MCP_ALLOWED_TOOLS) {
    const names = parseCommaList(process.env.SHOPIFY_MCP_ALLOWED_TOOLS);
    console.error(`[proxy] Tool filter: allow-list (${names.length} tools): ${names.join(', ')}`);
    return allowList(names);
  }

  if (process.env.SHOPIFY_MCP_BLOCKED_TOOLS) {
    const names = parseCommaList(process.env.SHOPIFY_MCP_BLOCKED_TOOLS);
    console.error(`[proxy] Tool filter: block-list (${names.length} tools): ${names.join(', ')}`);
    return blockList(names);
  }

  if (process.env.SHOPIFY_MCP_DOCS_ONLY === 'true') {
    console.error('[proxy] Tool filter: docs-only mode (store management tools hidden)');
    return docsOnlyFilter;
  }

  return undefined;
}

function parseCommaList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Built-in filter helpers
// ---------------------------------------------------------------------------

/**
 * Expose only developer documentation and schema tools.
 * Hides all store-management tools (products, orders, customers, inventory, etc.).
 *
 * Matched by tool name prefix/substring — works regardless of the exact names
 * @shopify/dev-mcp uses internally:
 *   - tools containing 'doc'   → docs search
 *   - tools containing 'schema'  → GraphQL schema introspection
 *   - tools containing 'introspect' → schema introspection
 *   - tools containing 'validate'   → GraphQL linting
 *   - tools containing 'reference'  → API reference
 *
 * Run `SHOPIFY_MCP_DOCS_ONLY=true` to activate.
 */
export function docsOnlyFilter(tool: Tool): boolean {
  const n = tool.name.toLowerCase();
  return (
    n.includes('doc') ||
    n.includes('schema') ||
    n.includes('introspect') ||
    n.includes('validate') ||
    n.includes('reference') ||
    n.includes('search_dev') ||
    n.includes('graphql_ref')
  );
}

/**
 * Create a filter that exposes only the named tools.
 * Any tool not in the list is hidden and its calls are blocked.
 *
 * @example
 *   allowList(['search_dev_docs', 'introspect_admin_schema'])
 */
export function allowList(names: string[]): (tool: Tool) => boolean {
  const set = new Set(names);
  return (tool) => set.has(tool.name);
}

/**
 * Create a filter that hides the named tools.
 * Everything else passes through.
 *
 * @example
 *   blockList(['create_product', 'delete_order'])
 */
export function blockList(names: string[]): (tool: Tool) => boolean {
  const set = new Set(names);
  return (tool) => !set.has(tool.name);
}
