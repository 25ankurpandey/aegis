/**
 * AEGIS AGENTIC LOOP — RUNNABLE DEMO HARNESS
 * =========================================
 *
 * Shows the whole governed loop end-to-end, in one process:
 *
 *   user message (English)
 *     -> the LLM (real gateway, or a deterministic offline STUB) picks among the FILTERED tools
 *       -> runAgentTurn invokes the chosen tool through the SAME guarded HTTP route a human hits
 *         (context -> authenticate -> authorize(Casbin PEP) -> validate -> handler -> errorMiddleware)
 *           -> the governed result (HTTP status + body) is pretty-printed.
 *
 * Three invariants are demonstrated on-screen:
 *   - the model is only ever shown the tools the principal may use (`listToolsForPrincipal`);
 *   - the DANGER gate (a second axis, orthogonal to authz) stops a WRITE from being auto-executed —
 *     `runAgentTurn` returns `needs_ceremony` (human confirmation/approval required), no HTTP call; and
 *   - even for a low-danger read that DOES execute, the governed core enforces authorization at the
 *     route: a principal whose bearer token lacks the grant is DENIED by the PEP (403). No bypass.
 *
 * HOW TO RUN (offline — zero external deps, no keys, no network) from the repo root.
 * The repo has only tsconfig.base.json (no root tsconfig.json), so ts-node must be pointed at it and at
 * tsconfig-paths so the @aegis/* aliases resolve:
 *   cd /Users/.../aegis
 *   TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
 *     node -r ts-node/register -r tsconfig-paths/register scripts/demo/agent-loop-demo.ts
 *
 * Alternatively (verified path, no env fiddling):
 *   npx nx test ai-core --skip-nx-cache --testPathPattern demo.spec
 *   (test/demo.spec.ts imports runDemo() from this file and asserts the governed statuses.)
 *
 * REAL-GATEWAY MODE (OpenAI / LiteLLM / OpenRouter / vLLM — any OpenAI-compatible endpoint):
 *   set these env vars and the harness uses OpenAiCompatibleLlmClient instead of the stub:
 *     AEGIS_LLM_BASE_URL   e.g. https://api.openai.com/v1  or  http://localhost:4000  (LiteLLM proxy)
 *     AEGIS_LLM_API_KEY    the gateway API key
 *     AEGIS_LLM_MODEL      optional; defaults to "gpt-4o-mini"
 *   e.g.
 *     AEGIS_LLM_BASE_URL=https://api.openai.com/v1 AEGIS_LLM_API_KEY=sk-... \
 *     TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
 *     TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
 *       node -r ts-node/register -r tsconfig-paths/register scripts/demo/agent-loop-demo.ts
 *
 * Nothing here depends on the real gateway: with no env vars set it runs fully offline.
 *
 * See scripts/demo/AGENT_LOOP_README.md for the full write-up and the scenario/outcome table.
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
  resetEnforcer,
} from '@aegis/access-control';
import { Permission } from '@aegis/shared-enums';
import {
  listToolsForPrincipal,
  toMcpToolDefinition,
  runAgentTurn,
  OpenAiCompatibleLlmClient,
  type AegisTool,
  type LlmClient,
  type LlmChooseToolInput,
  type LlmToolChoice,
  type AegisTurnResult,
} from '@aegis/ai-core';

// A UUID tenant (context middleware requires X-Tenant-Id to be a UUID).
const TENANT = '00000000-0000-4000-8000-000000000001';
// The JWT secret authenticate() reads at request time; we sign our demo tokens with the same one.
const SECRET = 'demo-secret';
process.env.AUTH_JWT_SECRET = SECRET;

// ---- The governed expense-like app (identical shape to libs/ai-core/test/tool-loop.spec.ts) ----------

const createExpenseSchema = Joi.object({
  amount: Joi.number().integer().required(),
  currency: Joi.string().length(3).optional(),
});
const expenseIdParamSchema = Joi.object({ id: Joi.string().uuid().required() });

function buildApp(): express.Application {
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

function tokenFor(roles: string[]): string {
  return jwt.sign({ sub: 'u1', tenant_id: TENANT, roles }, SECRET);
}

// ---- The offline STUB LlmClient: deterministically maps example prompts to a tool choice ------------
// It "reasons" only over the FILTERED tools it is handed (resolving by HTTP method, so it stays correct
// regardless of the exact generated tool name) — exactly the seam a real model reasons through.

class StubLlmClient implements LlmClient {
  async chooseTool(input: LlmChooseToolInput): Promise<LlmToolChoice> {
    const msg = input.userMessage.toLowerCase();
    const byMethod = (m: string) =>
      input.tools.find((t) => t.name.startsWith(`${m.toLowerCase()}_`));

    // "create / file / submit an expense for $X" -> the POST create tool.
    if (/\b(create|file|submit|add|new)\b/.test(msg) && msg.includes('expense')) {
      const amount = Number((msg.match(/\$?\s*(\d[\d,]*)/) ?? [])[1]?.replace(/,/g, '') ?? 0);
      const create = byMethod('POST');
      if (create) return { toolName: create.name, args: { amount } };
    }

    // "show / read / get expense <uuid>" -> the GET read-by-id tool.
    if (/\b(show|read|get|view|fetch|look\s*up)\b/.test(msg) && msg.includes('expense')) {
      const id = (msg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ??
        [])[0];
      const read = byMethod('GET');
      if (read && id) return { toolName: read.name, args: { id } };
    }

    // Anything the stub can't map to an offered tool -> reply in natural language (no tool call).
    return {
      assistantMessage:
        "I can create an expense (\"file an expense for $1500\") or read one by id — I couldn't map that request to a tool I'm allowed to use.",
    };
  }
}

// ---- Selection: real gateway if configured, else the offline stub ------------------------------------

function selectLlm(): { llm: LlmClient; mode: string } {
  const baseUrl = process.env.AEGIS_LLM_BASE_URL;
  const apiKey = process.env.AEGIS_LLM_API_KEY;
  if (baseUrl && apiKey) {
    const model = process.env.AEGIS_LLM_MODEL ?? 'gpt-4o-mini';
    return {
      llm: new OpenAiCompatibleLlmClient({ baseUrl, apiKey, model }),
      mode: `real gateway (OpenAI-compatible) @ ${baseUrl} model=${model}`,
    };
  }
  return { llm: new StubLlmClient(), mode: 'offline STUB (no AEGIS_LLM_* env set)' };
}

// ---- Pretty-printing ---------------------------------------------------------------------------------

type Logger = (s: string) => void;

function line(log: Logger): void {
  log('─'.repeat(78));
}

function describeTurn(log: Logger, result: AegisTurnResult): void {
  switch (result.kind) {
    case 'tool':
      log(`  LLM decision : call tool "${result.toolName}" args=${JSON.stringify(result.args)}`);
      log(`  Governed HTTP: ${result.result.status} (${result.result.ok ? 'ok' : 'blocked'})`);
      log(`  Body         : ${JSON.stringify(result.result.body)}`);
      break;
    case 'message':
      log(`  LLM decision : reply (no tool call)`);
      log(`  Message      : ${result.text}`);
      break;
    case 'refused':
      log(`  LLM decision : REFUSED by orchestrator`);
      log(`  Reason       : ${result.reason}`);
      break;
    case 'needs_ceremony':
      log(`  LLM decision : call tool "${result.toolName}" args=${JSON.stringify(result.args)}`);
      log(
        `  DANGER gate  : ceremony="${result.decision.ceremony}" (level ${result.decision.level}, ` +
          `requiresHuman=${result.decision.requiresHuman}) — NOT executed`,
      );
      log(`  Reasons      : ${result.decision.reasons.join('; ')}`);
      break;
  }
}

// ---- The demo body (exported so a spec can both verify AND run it) -----------------------------------

export interface DemoStepOutcome {
  label: string;
  turn: AegisTurnResult;
}

export interface DemoResult {
  mode: string;
  steps: DemoStepOutcome[];
}

export async function runDemo(log: (s: string) => void = console.log): Promise<DemoResult> {
  // Fresh, isolated in-memory PEP for the demo tenant.
  const enforcer = await createInMemoryEnforcer({
    policies: [
      { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportCreate },
      { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportView },
      { sub: 'viewer', dom: TENANT, act: Permission.ExpenseReportView },
    ],
  });
  setEnforcer(enforcer);

  const app = buildApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { llm, mode } = selectLlm();

  // Principals differ ONLY in the permissions they hold — that alone changes the offered tool set.
  const manager = {
    permissions: [String(Permission.ExpenseReportCreate), String(Permission.ExpenseReportView)],
  };
  const viewer = { permissions: [String(Permission.ExpenseReportView)] };
  const managerToken = tokenFor(['expense-manager']);
  const viewerToken = tokenFor(['viewer']);
  // A token whose role holds NO grant in the enforcer — used to show the PEP denying at the route.
  const noAccessToken = tokenFor(['no-access']);

  const readId = '00000000-0000-4000-8000-0000000000aa';

  const scenarios: Array<{
    label: string;
    userMessage: string;
    principal: { permissions: string[] };
    token: string;
  }> = [
    {
      // A create is a WRITE. The danger gate (2nd axis) stops it before any HTTP call: runAgentTurn
      // returns needs_ceremony (human confirmation/approval required). Write-autonomy is OFF by design.
      label: '1) Manager asks to create an expense -> DANGER GATE requires human ceremony (not auto-executed)',
      userMessage: 'Please file an expense for $1500 for the client dinner.',
      principal: manager,
      token: managerToken,
    },
    {
      label: `2) Manager reads an expense by id (low-danger read -> auto-executes, governed 200)`,
      userMessage: `Show me expense ${readId}.`,
      principal: manager,
      token: managerToken,
    },
    {
      label: '3) Viewer tries to create an expense (tool not even offered -> reply, no HTTP)',
      userMessage: 'Please file an expense for $999.',
      principal: viewer,
      token: viewerToken,
    },
    {
      // The model is SHOWN the read tool (manager offer) and reads are low-danger (they execute), but the
      // ACTUAL bearer token holds no grant. The core's PEP DENIES at the route (403) — the agent cannot
      // bypass it; governance is at the route, not the model. (This is the no-bypass proof on a tool that
      // the danger gate lets through, unlike a write.)
      label: '4) PEP denies a low-danger read at the route despite the offer (403) — no bypass',
      userMessage: `Show me expense ${readId}.`,
      principal: manager, // what the model is SHOWN (read offered)
      token: noAccessToken, // who the request actually runs AS (no grant) — the core governs this
    },
    {
      label: '5) Off-topic request (LLM replies, no tool call)',
      userMessage: 'What is the capital of France?',
      principal: manager,
      token: managerToken,
    },
  ];

  const steps: DemoStepOutcome[] = [];

  log('');
  line(log);
  log(`AEGIS agentic loop demo — LLM mode: ${mode}`);
  log(`Governed service listening at ${baseUrl}`);
  line(log);

  for (const sc of scenarios) {
    // Surface the FILTERED tool offer for this principal (what the model is allowed to see).
    const offered: AegisTool[] = listToolsForPrincipal(app, { permissions: sc.principal.permissions });
    log('');
    log(sc.label);
    log(`  User message : ${sc.userMessage}`);
    log(
      `  Tools offered: [${offered.map((t) => t.name).join(', ') || '(none)'}]  ` +
        `(from ${offered.length} filtered / MCP defs: ${offered.map(toMcpToolDefinition).length})`,
    );

    const turn = await runAgentTurn({
      app,
      llm,
      invoke: { baseUrl, token: sc.token, tenantId: TENANT },
      principal: sc.principal,
      userMessage: sc.userMessage,
    });
    describeTurn(log, turn);
    steps.push({ label: sc.label, turn });
  }

  log('');
  line(log);
  log('Demo complete — the agent hit the same guarded routes a human hits; the core governed each call.');
  line(log);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetEnforcer();

  return { mode, steps };
}

// ---- Run directly (npx ts-node scripts/demo/agent-loop-demo.ts) --------------------------------------

// `require.main === module` is true only when this file is executed directly, not when imported by a spec.
if (require.main === module) {
  runDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
