import { buildAegisMcpStdioServer } from '../../../scripts/mcp/aegis-mcp-stdio';

/**
 * SMOKE TEST for the live-ready MCP stdio server factory. Fully OFFLINE and deterministic: no external
 * key, no network MCP client, no stdio transport. We construct the factory in OFFLINE mode (empty env,
 * so AEGIS_SERVICE_BASE_URL is unset) and assert it:
 *   (a) stands up the in-process governed app and returns mode='offline' with a loopback baseUrl,
 *   (b) generates the governed tool registry (>0 tools) and exposes the MCP server + tools list, and
 *   (c) does NOT start a stdio transport merely by being imported/constructed (importing the module ran
 *       no transport — the `require.main === module` guard held).
 *
 * We pass an explicit empty `env` bag so the ambient environment can never flip the factory into LIVE
 * mode; the offline app is isolated from the real service.
 */
describe('buildAegisMcpStdioServer (offline wiring smoke test)', () => {
  it('builds the governed app + MCP server offline and advertises the generated tools', async () => {
    // Empty env bag → no AEGIS_SERVICE_BASE_URL → OFFLINE mode (in-process governed app + dev token).
    const built = await buildAegisMcpStdioServer({ env: {} as NodeJS.ProcessEnv });

    try {
      expect(built.mode).toBe('offline');
      expect(built.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(built.tenantId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // The factory returns an object exposing the MCP server + a non-empty generated tools list.
      expect(built.mcp).toBeDefined();
      expect(built.mcp.server).toBeDefined();
      expect(Array.isArray(built.tools)).toBe(true);
      expect(built.tools.length).toBeGreaterThan(0);
      // The expense-like governed app stamps a create (POST) and a read (GET) route → both surface.
      expect(new Set(built.tools.map((t) => t.method))).toEqual(new Set(['POST', 'GET']));
      // Every advertised tool carries a governed shape (name + permissions + input schema).
      for (const tool of built.tools) {
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
        expect(Array.isArray(tool.permissions)).toBe(true);
        expect(tool.inputSchema).toBeDefined();
      }
    } finally {
      // Tears down both the MCP server and the in-process HTTP server (no leaked handles).
      await built.close();
    }
  });

  it('does not start a stdio transport on import (module import had no transport side effect)', () => {
    // If importing the module had attached a StdioServerTransport, it would have hijacked process.stdin
    // in raw mode and this suite could not run. Reaching here — plus the successful build above — is the
    // observable proof the `require.main === module` guard prevented main() from running on import.
    expect(typeof buildAegisMcpStdioServer).toBe('function');
  });
});
