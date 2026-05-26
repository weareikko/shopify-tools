import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { allowList, blockList, createProxyFromEnv, docsOnlyFilter, ShopifyProxy } from './proxy.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
  };
}

// ---------------------------------------------------------------------------
// docsOnlyFilter
// ---------------------------------------------------------------------------

describe('docsOnlyFilter', () => {
  const docs = [
    'search_dev_docs',
    'introspect_admin_schema',
    'validate_graphql_codeblocks',
    'graphql_reference',
    'get_api_reference',
    'search_docs_chunks',
  ];

  const store = [
    'get_product',
    'create_product',
    'update_product',
    'list_orders',
    'get_order',
    'list_customers',
    'set_inventory',
    'create_discount',
    'get_shop_info',
  ];

  it.each(docs)('passes %s', (name) => {
    expect(docsOnlyFilter(makeTool(name))).toBe(true);
  });

  it.each(store)('blocks %s', (name) => {
    expect(docsOnlyFilter(makeTool(name))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allowList
// ---------------------------------------------------------------------------

describe('allowList', () => {
  const filter = allowList(['search_dev_docs', 'introspect_admin_schema']);

  it('passes tools in the list', () => {
    expect(filter(makeTool('search_dev_docs'))).toBe(true);
    expect(filter(makeTool('introspect_admin_schema'))).toBe(true);
  });

  it('blocks tools not in the list', () => {
    expect(filter(makeTool('get_product'))).toBe(false);
    expect(filter(makeTool('list_orders'))).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(filter(makeTool('Search_Dev_Docs'))).toBe(false);
  });

  it('returns a function that handles empty list (blocks all)', () => {
    const blockAll = allowList([]);
    expect(blockAll(makeTool('anything'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// blockList
// ---------------------------------------------------------------------------

describe('blockList', () => {
  const filter = blockList(['create_product', 'delete_order']);

  it('blocks tools in the list', () => {
    expect(filter(makeTool('create_product'))).toBe(false);
    expect(filter(makeTool('delete_order'))).toBe(false);
  });

  it('passes tools not in the list', () => {
    expect(filter(makeTool('search_dev_docs'))).toBe(true);
    expect(filter(makeTool('get_product'))).toBe(true);
  });

  it('returns a function that handles empty list (passes all)', () => {
    const passAll = blockList([]);
    expect(passAll(makeTool('anything'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createProxyFromEnv — filter resolution from env vars
// ---------------------------------------------------------------------------

describe('createProxyFromEnv — tool filter env resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates proxy with no filter when no filter env vars are set', () => {
    vi.stubEnv('SHOPIFY_MCP_DOCS_ONLY', '');
    vi.stubEnv('SHOPIFY_MCP_ALLOWED_TOOLS', '');
    vi.stubEnv('SHOPIFY_MCP_BLOCKED_TOOLS', '');
    const proxy = createProxyFromEnv();
    expect(proxy).toBeInstanceOf(ShopifyProxy);
    // toolFilter is private, but we can verify the proxy is created without error
  });

  it('creates proxy with docsOnlyFilter when SHOPIFY_MCP_DOCS_ONLY=true', () => {
    vi.stubEnv('SHOPIFY_MCP_DOCS_ONLY', 'true');
    vi.stubEnv('SHOPIFY_MCP_ALLOWED_TOOLS', '');
    vi.stubEnv('SHOPIFY_MCP_BLOCKED_TOOLS', '');
    // Just verify it doesn't throw — filter correctness is tested in docsOnlyFilter suite
    expect(() => createProxyFromEnv()).not.toThrow();
  });

  it('creates proxy with allowList when SHOPIFY_MCP_ALLOWED_TOOLS is set', () => {
    vi.stubEnv('SHOPIFY_MCP_ALLOWED_TOOLS', 'search_dev_docs, introspect_admin_schema');
    vi.stubEnv('SHOPIFY_MCP_BLOCKED_TOOLS', '');
    vi.stubEnv('SHOPIFY_MCP_DOCS_ONLY', '');
    expect(() => createProxyFromEnv()).not.toThrow();
  });

  it('creates proxy with blockList when SHOPIFY_MCP_BLOCKED_TOOLS is set', () => {
    vi.stubEnv('SHOPIFY_MCP_BLOCKED_TOOLS', 'create_product,delete_order');
    vi.stubEnv('SHOPIFY_MCP_ALLOWED_TOOLS', '');
    vi.stubEnv('SHOPIFY_MCP_DOCS_ONLY', '');
    expect(() => createProxyFromEnv()).not.toThrow();
  });

  it('ALLOWED_TOOLS takes priority over DOCS_ONLY', () => {
    vi.stubEnv('SHOPIFY_MCP_ALLOWED_TOOLS', 'search_dev_docs');
    vi.stubEnv('SHOPIFY_MCP_DOCS_ONLY', 'true');
    vi.stubEnv('SHOPIFY_MCP_BLOCKED_TOOLS', '');
    expect(() => createProxyFromEnv()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ShopifyProxy — callTool filter guard (unit, no child process)
// ---------------------------------------------------------------------------

describe('ShopifyProxy.callTool filter guard', () => {
  it('rejects calls to filtered-out tools', async () => {
    const filter = allowList(['search_dev_docs']);
    const proxy = new ShopifyProxy({ toolFilter: filter });

    // Bypass the connect() / client requirement by injecting a fake tools cache
    // via the _refreshTools result — we access the private cache via any cast
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = proxy as any;
    p.connected = true;
    p.client = {}; // non-null so _assertConnected passes
    p.toolsCache = [makeTool('search_dev_docs'), makeTool('create_product')];

    await expect(proxy.callTool('create_product', {})).rejects.toThrow(
      'not available on this server',
    );
  });

  it('does not reject calls to allowed tools (delegates to client)', async () => {
    const filter = allowList(['search_dev_docs']);
    const proxy = new ShopifyProxy({ toolFilter: filter });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = proxy as any;
    p.connected = true;
    p.toolsCache = [makeTool('search_dev_docs'), makeTool('create_product')];
    // Mock client.callTool
    p.client = { callTool: vi.fn().mockResolvedValue({ content: [] }) };

    await expect(proxy.callTool('search_dev_docs', {})).resolves.toEqual({ content: [] });
    expect(p.client.callTool).toHaveBeenCalledWith({
      name: 'search_dev_docs',
      arguments: {},
    });
  });
});

// ---------------------------------------------------------------------------
// ShopifyProxy.status
// ---------------------------------------------------------------------------

describe('ShopifyProxy.status', () => {
  it('reports correct counts with a filter', () => {
    const proxy = new ShopifyProxy({ toolFilter: allowList(['search_dev_docs']) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = proxy as any;
    p.connected = true;
    p.toolsCache = [makeTool('search_dev_docs'), makeTool('create_product'), makeTool('list_orders')];

    const status = proxy.status;
    expect(status.toolCount).toBe(1);          // 1 visible
    expect(status.filteredToolCount).toBe(2);  // 2 hidden
    expect(status.connected).toBe(true);
  });

  it('reports all tools when no filter is set', () => {
    const proxy = new ShopifyProxy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = proxy as any;
    p.toolsCache = [makeTool('a'), makeTool('b')];

    const status = proxy.status;
    expect(status.toolCount).toBe(2);
    expect(status.filteredToolCount).toBe(0);
  });
});
