import type { Application } from 'express';
import {
  generateToolRegistry,
  type GenerateOptions,
} from '../tool-registry/generate-tool-registry';
import {
  filterToolsForPrincipal,
  type ToolFilterContext,
} from '../tool-registry/filter-tools';
import { invokeTool, toMcpToolDefinition } from '../tool-server/tool-server';
import type { AegisTool } from '../tool-registry/types';
import { deriveDangerFacts } from '../orchestrator/derive-danger-facts';
import { evaluateActionGate, type DangerGateContext } from '../danger/danger-gate';

/**
 * MCP TRANSPORT for the governed tool registry: expose a service's auto-generated, authz-bound tools
 * over the Model Context Protocol so an external MCP client (Claude Desktop, an IDE, another agent)
 * can `tools/list` and `tools/call` them.
 *
 * GOVERNANCE IS UNCHANGED BY THIS LAYER. MCP is only a *discovery + invocation* surface; it does not
 * grant any authority. Every `tools/call` handler here funnels through {@link invokeTool}, which hits
 * **the same guarded HTTP route a human hits** (Bearer token + `x-tenant-id`), so the request still
 * traverses the real `context → authenticate → authorize(PEP) → validate → RLS → handler → audit`
 * chain. The MCP client is just another *principal* wielding a delegated token — never a bypass. The
 * `inputSchema` advertised over MCP is best-effort context for the model; the load-bearing gates remain
 * the PEP (authz) and `validate()` (input) at execution time, exactly as in the tool-loop.
 *
 * DANGER GATE (§3). Before invoking, `tools/call` runs the deterministic danger gate
 * (`evaluateActionGate(deriveDangerFacts(tool, args), ctx)`). If the required ceremony is anything other
 * than `allow`, the handler DOES NOT invoke: it returns an `isError` result whose JSON body describes the
 * required ceremony, so the MCP client must route the action through the human ceremony surface (and the
 * supervised-write path) rather than firing it autonomously. This is the friction axis (DANGER), sitting
 * on TOP of the authorization the route already enforces — it can only tighten, never loosen.
 *
 * SDK LOADING. The `@modelcontextprotocol/sdk` package is ESM-only and ships its public API behind
 * subpath `"exports"`. The repo tsconfig uses `module: commonjs` / `moduleResolution: node`, which does
 * not read that `exports` map, and its subpath `.d.ts` types therefore do not resolve cleanly. To stay
 * strict-typecheck-clean WITHOUT editing the shared tsconfig, we wrap the tiny slice of the SDK we use
 * behind a local typed facade (below) and load it dynamically at runtime — never via a static import, so
 * TypeScript emits no `require('@modelcontextprotocol/sdk')` that a CommonJS host could choke on. Nothing
 * about the SDK version is pinned in types here — the facade only describes the low-level `Server` + the
 * request-schema constants we pass to it.
 *
 * The loader prefers a genuine ESM dynamic `import()` (correct under a native ESM/Node runtime). Some
 * CommonJS hosts (e.g. Jest's default VM) forbid dynamic ESM import; there we transparently fall back to
 * requiring the SDK's shipped CommonJS build, located by walking up `node_modules`. Either way the caller
 * gets the same typed facade.
 */

/** Minimal MCP content block we emit (a JSON text block). Mirrors the SDK's `TextContent`. */
interface McpTextContent {
  type: 'text';
  text: string;
}

/** The `tools/call` result shape we return (JSON-as-text; `isError` on a governed failure). */
interface McpCallToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

/** The subset of the SDK's low-level `Server` we depend on. */
interface McpLowLevelServer {
  registerCapabilities(capabilities: Record<string, unknown>): void;
  setRequestHandler(
    requestSchema: unknown,
    handler: (request: unknown) => unknown | Promise<unknown>,
  ): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

/** The slice of the SDK module graph the facade loads dynamically. */
interface McpSdkFacade {
  Server: new (
    serverInfo: { name: string; version: string },
    options?: { capabilities?: Record<string, unknown> },
  ) => McpLowLevelServer;
  ListToolsRequestSchema: unknown;
  CallToolRequestSchema: unknown;
}

/**
 * Dynamic `import()` that survives CommonJS transpilation. TypeScript targeting `module: commonjs`
 * rewrites a literal `import()` into `require()`, which cannot load the ESM-only SDK; the `Function`
 * indirection preserves a real runtime `import()`.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<Record<string, unknown>>;

/** Locate the SDK's shipped CommonJS build by walking up from `startDir` through `node_modules`. */
function resolveSdkCjsDir(startDir: string): string {
  // Deferred requires so a native-ESM build path never pays for Node's `fs`/`path` here.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path');
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@modelcontextprotocol', 'sdk');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return path.join(candidate, 'dist', 'cjs');
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot locate @modelcontextprotocol/sdk under node_modules');
    dir = parent;
  }
}

/** Require the SDK's CommonJS build (fallback for hosts that forbid dynamic ESM import, e.g. Jest). */
function loadSdkFromCjs(): McpSdkFacade {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path');
  const cjsDir = resolveSdkCjsDir(process.cwd());
  /* eslint-disable @typescript-eslint/no-var-requires */
  const serverMod = require(path.join(cjsDir, 'server', 'index.js')) as Record<string, unknown>;
  const typesMod = require(path.join(cjsDir, 'types.js')) as Record<string, unknown>;
  /* eslint-enable @typescript-eslint/no-var-requires */
  return {
    Server: serverMod.Server as McpSdkFacade['Server'],
    ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
    CallToolRequestSchema: typesMod.CallToolRequestSchema,
  };
}

async function loadSdk(): Promise<McpSdkFacade> {
  try {
    const serverMod = await dynamicImport('@modelcontextprotocol/sdk/server/index.js');
    const typesMod = await dynamicImport('@modelcontextprotocol/sdk/types.js');
    return {
      Server: serverMod.Server as McpSdkFacade['Server'],
      ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
      CallToolRequestSchema: typesMod.CallToolRequestSchema,
    };
  } catch {
    // Host forbids dynamic ESM import (e.g. Jest without --experimental-vm-modules) — use the CJS build.
    return loadSdkFromCjs();
  }
}

/** Options for {@link createAegisMcpToolServer}. */
export interface CreateAegisMcpToolServerOptions {
  /** The live Express app whose stamped routes become MCP tools. */
  app: Application;
  /** How to reach the governed service, and as whom, when a tool is invoked. */
  invoke: {
    /** Base URL of the running service, e.g. `http://127.0.0.1:4002`. */
    baseUrl: string;
    /** Supplies the caller's bearer JWT per call (lets tokens rotate / be minted on demand). */
    tokenProvider: () => string | Promise<string>;
    /** The tenant the calls run in (the core re-checks this against the token). */
    tenantId: string;
  };
  /** Optionally scope the exposed tools to a principal's permissions / enabled modules. */
  filter?: ToolFilterContext;
  /** Forwarded to {@link generateToolRegistry} (route prefix, method skips, etc.). */
  generateOptions?: GenerateOptions;
  /** MCP server identity advertised to clients (defaults provided). */
  serverInfo?: { name: string; version: string };
  /**
   * OPT-IN context for the DANGER gate that runs before every `tools/call`. When supplied, each call
   * first runs `evaluateActionGate(deriveDangerFacts(tool, args), dangerContext)`; a decision whose
   * ceremony !== `allow` short-circuits the call with an `isError` result describing the required
   * ceremony (NO invocation), so the client must route the action through the human ceremony surface +
   * supervised-write path. Pass `{}` to enable the gate with platform-floor defaults (no per-tenant
   * overrides). Omit it entirely to leave the transport as a pure discovery/invocation surface (the gate
   * does not run) — governance then rests solely on the guarded route's own PEP, exactly as before.
   */
  dangerContext?: DangerGateContext;
}

/** What the factory returns: the constructed MCP server plus the tool list it exposed. */
export interface AegisMcpToolServer {
  /**
   * The constructed low-level MCP `Server`, transport-agnostic. The caller connects it to a transport
   * (`StdioServerTransport`, `StreamableHTTPServerTransport`, …) — this layer deliberately hardcodes no
   * transport. Type-erased to `unknown` because the SDK types are loaded dynamically; cast at the call
   * site if you need the concrete SDK type.
   */
  server: unknown;
  /** The exact tools registered (post-filter), in registration order — handy for tests/introspection. */
  tools: AegisTool[];
  /** Connect the server to an already-constructed SDK transport. */
  connect(transport: unknown): Promise<void>;
  /** Close the underlying server. */
  close(): Promise<void>;
}

/**
 * Build an MCP server that exposes an Express service's auto-generated tool registry over MCP.
 *
 * It (1) generates the registry from `opts.app` and optionally filters it for a principal, (2) advertises
 * each tool via {@link toMcpToolDefinition} (name/description/JSON-Schema `inputSchema`) in `tools/list`,
 * and (3) routes every `tools/call` through {@link invokeTool} — i.e. the guarded HTTP route — returning
 * the governed response as a JSON text content block. The returned server is transport-agnostic.
 */
export async function createAegisMcpToolServer(
  opts: CreateAegisMcpToolServerOptions,
): Promise<AegisMcpToolServer> {
  const sdk = await loadSdk();

  const allTools = generateToolRegistry(opts.app, opts.generateOptions).tools;
  const tools = opts.filter ? filterToolsForPrincipal(allTools, opts.filter) : allTools;

  const byName = new Map<string, AegisTool>();
  for (const tool of tools) byName.set(tool.name, tool);

  const serverInfo = opts.serverInfo ?? { name: 'aegis-mcp-tool-server', version: '0.1.0' };
  const server = new sdk.Server(serverInfo, { capabilities: { tools: {} } });

  // tools/list — advertise the governed tools (JSON-Schema inputSchema passes through untouched).
  server.setRequestHandler(sdk.ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => toMcpToolDefinition(tool)),
  }));

  // tools/call — invoke via the GUARDED route; the governed core is the sole authority.
  server.setRequestHandler(sdk.CallToolRequestSchema, async (request: unknown) => {
    const params = (request as { params?: { name?: string; arguments?: unknown } }).params ?? {};
    const name = params.name ?? '';
    const tool = byName.get(name);
    if (!tool) {
      return errorResult(`Unknown tool: ${name}`);
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    // DANGER GATE (opt-in) — deterministic, runs BEFORE any invocation. A ceremony other than `allow`
    // means this action needs human friction (confirm/typed-confirm/step-up/approver/…) or is blocked; we
    // DO NOT invoke. We return an isError result whose body names the required ceremony so the client
    // routes it through the human ceremony surface + supervised-write path instead of firing it
    // autonomously. Skipped entirely when no `dangerContext` was supplied (transport-only mode).
    if (opts.dangerContext) {
      const decision = evaluateActionGate(deriveDangerFacts(tool, args), opts.dangerContext);
      if (decision.ceremony !== 'allow') {
        return {
          content: [
            {
              type: 'text',
              text: jsonText({
                error: 'ceremony_required',
                tool: tool.name,
                ceremony: decision.ceremony,
                level: decision.level,
                requiresHuman: decision.requiresHuman,
                ...(decision.typedConfirmationPhrase
                  ? { typedConfirmationPhrase: decision.typedConfirmationPhrase }
                  : {}),
                ...(decision.coolingOffMs ? { coolingOffMs: decision.coolingOffMs } : {}),
                ...(decision.requiresOutOfBand ? { requiresOutOfBand: decision.requiresOutOfBand } : {}),
                reasons: decision.reasons,
              }),
            },
          ],
          isError: true,
        } satisfies McpCallToolResult;
      }
    }

    const token = await opts.invoke.tokenProvider();
    const result = await invokeTool(tool, args, {
      baseUrl: opts.invoke.baseUrl,
      token,
      tenantId: opts.invoke.tenantId,
    });
    // Surface the governed response verbatim. A non-2xx (403/400/401/…) is a governance decision, not a
    // transport fault — we mark it `isError` so the model sees it was denied/rejected, with the body.
    return {
      content: [{ type: 'text', text: jsonText(result.body) }],
      isError: !result.ok,
    } satisfies McpCallToolResult;
  });

  return {
    server,
    tools,
    connect: (transport: unknown) => server.connect(transport),
    close: () => server.close(),
  };
}

function errorResult(message: string): McpCallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function jsonText(body: unknown): string {
  try {
    return JSON.stringify(body ?? null, null, 2);
  } catch {
    return String(body);
  }
}
