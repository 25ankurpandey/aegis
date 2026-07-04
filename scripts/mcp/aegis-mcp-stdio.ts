/**
 * AEGIS MCP STDIO SERVER — LIVE-READY, GOVERNED-BY-CONSTRUCTION
 * ============================================================
 *
 * Makes the Aegis governed tool registry driveable by a REAL MCP client (Claude Desktop, an IDE, another
 * agent) over stdio. It exposes the auto-generated, authz-bound tools via `tools/list` and routes every
 * `tools/call` through {@link createAegisMcpToolServer} → {@link invokeTool} — i.e. the SAME guarded HTTP
 * route a human hits (`context → authenticate → authorize(PEP) → validate → RLS → handler → audit`). MCP
 * is only a discovery + invocation surface here; it grants NO authority. The MCP client is just another
 * principal wielding a delegated bearer token — never a bypass.
 *
 * TWO MODES (chosen from env, so the same binary works live and offline):
 *   • LIVE   — if AEGIS_SERVICE_BASE_URL is set, we target that already-running governed service. The
 *              bearer token comes from AEGIS_AGENT_TOKEN and the tenant from AEGIS_TENANT_ID. Nothing is
 *              stood up in-process; we only generate the registry from a locally-built app of the same
 *              shape so `tools/list` is populated, and forward `tools/call` to the live baseUrl.
 *   • OFFLINE — with no AEGIS_SERVICE_BASE_URL, we stand up the SAME in-process governed expense-like app
 *              the agent-loop demo uses (Casbin in-memory PEP + JWT), and mint a locally-signed dev token.
 *              Zero external deps, no keys, no network — for local development and CI wiring checks.
 *
 * SDK LOADING. `@modelcontextprotocol/sdk` is ESM-only behind subpath `exports`; the repo tsconfig is
 * `module: commonjs` / `moduleResolution: node` and cannot statically import it cleanly. We mirror the
 * loader in `libs/ai-core/src/mcp/mcp-tool-server.ts`: a `Function`-indirected dynamic `import()` (which
 * survives CommonJS transpilation), with a fallback that `require()`s the SDK's shipped CommonJS build by
 * walking up `node_modules`. The transport (`StdioServerTransport`) is loaded THIS way and only when
 * `main()` runs — importing this module never touches a transport.
 *
 * HOW TO RUN — see scripts/mcp/AEGIS_MCP_README.md (Claude Desktop config snippet + the real-LLM-gateway
 * path for the orchestrator demo).
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import { contextMiddleware, validate, errorMiddleware } from '@aegis/service-core';
import {
  authenticate,
  authorize,
  createInMemoryEnforcer,
  setEnforcer,
} from '@aegis/access-control';
import { Permission } from '@aegis/shared-enums';
// Cross-module import via RELATIVE src path (NOT the @aegis/ai-core barrel — the barrel pulls in other
// agents' in-progress files during parallel work).
import {
  createAegisMcpToolServer,
  type AegisMcpToolServer,
} from '../../libs/ai-core/src/mcp/mcp-tool-server';
import type { AegisTool } from '../../libs/ai-core/src/tool-registry/types';

// ---- Defaults for OFFLINE mode (mirror scripts/demo/agent-loop-demo.ts) ------------------------------

/** A UUID tenant — the context middleware requires X-Tenant-Id to be a UUID. */
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
/** JWT secret authenticate() reads at request time; offline dev tokens are signed with the same one. */
const DEFAULT_SECRET = 'demo-secret';

// ---- The governed expense-like app (identical shape to the demo + tool-loop spec) --------------------

const createExpenseSchema = Joi.object({
  amount: Joi.number().integer().required(),
  currency: Joi.string().length(3).optional(),
});
const expenseIdParamSchema = Joi.object({ id: Joi.string().uuid().required() });

function buildGovernedApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(contextMiddleware({ mintCorrelationIdIfAbsent: true }));
  app.post(
    '/expense/v1/expenses',
    authenticate(),
    authorize(Permission.ExpenseReportCreate),
    validate(createExpenseSchema),
    (req, res) => res.status(201).json({ data: { created: true, amount: req.body.amount } }),
  );
  app.get(
    '/expense/v1/expenses/:id',
    authenticate(),
    authorize(Permission.ExpenseReportView),
    validate(expenseIdParamSchema, 'params'),
    (req, res) => res.status(200).json({ data: { id: req.params.id } }),
  );
  app.use(errorMiddleware);
  return app;
}

/** Mint a locally-signed dev bearer token for OFFLINE mode. */
function signDevToken(secret: string, tenantId: string, roles: string[]): string {
  return jwt.sign({ sub: 'aegis-mcp-agent', tenant_id: tenantId, roles }, secret);
}

// ---- Factory options / result -------------------------------------------------------------------------

export interface BuildAegisMcpStdioServerOptions {
  /**
   * Explicit env bag (defaults to `process.env`). Injectable so tests can construct deterministic OFFLINE
   * mode regardless of the ambient environment.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Optionally scope the exposed tools to a principal's permissions / enabled modules. When omitted, ALL
   * generated tools are advertised (the governed core still re-checks authz per `tools/call`, so this is
   * only a discovery-surface convenience, never the authority).
   */
  filter?: { permissions: string[]; enabledModules?: string[] };
}

export interface AegisMcpStdioServer {
  /** `'live'` when targeting AEGIS_SERVICE_BASE_URL, else `'offline'` (in-process governed app). */
  mode: 'live' | 'offline';
  /** The base URL every governed `tools/call` is sent to. */
  baseUrl: string;
  /** The tenant all calls run in (the core re-checks this against the token). */
  tenantId: string;
  /** The constructed MCP tool server (transport-agnostic — see {@link AegisMcpToolServer}). */
  mcp: AegisMcpToolServer;
  /** The exact governed tools advertised over MCP (post-filter), for tests/introspection. */
  tools: AegisTool[];
  /** Connect the MCP server to an already-constructed SDK transport (e.g. stdio). */
  connect(transport: unknown): Promise<void>;
  /** Close the MCP server AND, in OFFLINE mode, the in-process HTTP server. */
  close(): Promise<void>;
}

/**
 * Build the Aegis MCP stdio server WITHOUT starting a transport. Exported (and transport-free) so it is
 * unit-testable and importable without side effects. `main()` below is what actually attaches stdio.
 */
export async function buildAegisMcpStdioServer(
  opts: BuildAegisMcpStdioServerOptions = {},
): Promise<AegisMcpStdioServer> {
  const env = opts.env ?? process.env;
  const liveBaseUrl = env.AEGIS_SERVICE_BASE_URL;

  if (liveBaseUrl) {
    // ---- LIVE mode: target an already-running governed service --------------------------------------
    const tenantId = env.AEGIS_TENANT_ID ?? DEFAULT_TENANT;
    const agentToken = env.AEGIS_AGENT_TOKEN;
    if (!agentToken) {
      throw new Error(
        'AEGIS_SERVICE_BASE_URL is set (LIVE mode) but AEGIS_AGENT_TOKEN is missing — a delegated ' +
          'bearer token is required so tools/call can traverse the guarded route as a real principal.',
      );
    }
    // We still need a locally-built app of the same shape to GENERATE the registry for tools/list; the
    // routes themselves are never executed in-process here — invokeTool forwards to `liveBaseUrl`.
    const app = buildGovernedApp();
    const mcp = await createAegisMcpToolServer({
      app,
      invoke: {
        baseUrl: liveBaseUrl,
        tokenProvider: () => agentToken,
        tenantId,
      },
      filter: opts.filter,
    });
    return {
      mode: 'live',
      baseUrl: liveBaseUrl,
      tenantId,
      mcp,
      tools: mcp.tools,
      connect: (transport: unknown) => mcp.connect(transport),
      close: () => mcp.close(),
    };
  }

  // ---- OFFLINE mode: stand up the same in-process governed app the demo uses ------------------------
  const tenantId = env.AEGIS_TENANT_ID ?? DEFAULT_TENANT;
  const secret = env.AUTH_JWT_SECRET ?? DEFAULT_SECRET;
  // authenticate() reads AUTH_JWT_SECRET at request time; make sure it matches the token we sign.
  env.AUTH_JWT_SECRET = secret;
  process.env.AUTH_JWT_SECRET = secret;

  const enforcer = await createInMemoryEnforcer({
    policies: [
      { sub: 'expense-manager', dom: tenantId, act: Permission.ExpenseReportCreate },
      { sub: 'expense-manager', dom: tenantId, act: Permission.ExpenseReportView },
      { sub: 'viewer', dom: tenantId, act: Permission.ExpenseReportView },
    ],
  });
  setEnforcer(enforcer);

  const app = buildGovernedApp();
  const httpServer: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  // A locally-signed dev token. Prefer an explicit AEGIS_AGENT_TOKEN if the caller supplied one; else
  // mint an expense-manager token so the offline server can exercise both read + create tools.
  const token =
    env.AEGIS_AGENT_TOKEN ?? signDevToken(secret, tenantId, ['expense-manager']);

  const mcp = await createAegisMcpToolServer({
    app,
    invoke: {
      baseUrl,
      tokenProvider: () => token,
      tenantId,
    },
    filter: opts.filter,
  });

  return {
    mode: 'offline',
    baseUrl,
    tenantId,
    mcp,
    tools: mcp.tools,
    connect: (transport: unknown) => mcp.connect(transport),
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// ---- SDK transport loader (mirrors libs/ai-core/src/mcp/mcp-tool-server.ts) ---------------------------

/** The slice of `StdioServerTransport` we use. */
interface StdioServerTransportCtor {
  new (): unknown;
}

/**
 * Dynamic `import()` that survives CommonJS transpilation. TS targeting `module: commonjs` rewrites a
 * literal `import()` into `require()`, which cannot load the ESM-only SDK; the `Function` indirection
 * preserves a real runtime `import()`. Same technique as the tool-server file.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<Record<string, unknown>>;

/** Locate the SDK's shipped CommonJS build by walking up from `startDir` through `node_modules`. */
function resolveSdkCjsDir(startDir: string): string {
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
    if (parent === dir) {
      throw new Error('Cannot locate @modelcontextprotocol/sdk under node_modules');
    }
    dir = parent;
  }
}

/** Load `StdioServerTransport`, preferring native ESM `import()`, falling back to the CJS build. */
async function loadStdioServerTransport(): Promise<StdioServerTransportCtor> {
  try {
    const mod = await dynamicImport('@modelcontextprotocol/sdk/server/stdio.js');
    return mod.StdioServerTransport as StdioServerTransportCtor;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const cjsDir = resolveSdkCjsDir(process.cwd());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(cjsDir, 'server', 'stdio.js')) as Record<string, unknown>;
    return mod.StdioServerTransport as StdioServerTransportCtor;
  }
}

// ---- Thin main(): attach stdio and serve (only when run directly) -------------------------------------

/**
 * Start the server on stdio. All human-readable status goes to STDERR — STDOUT is the MCP wire and must
 * carry only protocol frames.
 */
export async function main(): Promise<void> {
  const built = await buildAegisMcpStdioServer();
  const Transport = await loadStdioServerTransport();
  const transport = new Transport();
  await built.connect(transport);
  process.stderr.write(
    `[aegis-mcp] serving on stdio — mode=${built.mode} baseUrl=${built.baseUrl} ` +
      `tenant=${built.tenantId} tools=${built.tools.length} ` +
      `[${built.tools.map((t) => t.name).join(', ')}]\n` +
      `[aegis-mcp] every tools/call still traverses the governed core (authenticate→authorize→validate→RLS→audit); MCP is not a bypass.\n`,
  );
}

// `require.main === module` is true only when this file is executed directly, not when imported by a spec.
// Importing this module therefore NEVER starts a stdio transport.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[aegis-mcp] fatal: ${String(err instanceof Error ? err.stack : err)}\n`);
    process.exit(1);
  });
}
