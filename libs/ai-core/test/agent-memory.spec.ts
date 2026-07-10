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
import type {
  LlmChooseToolInput,
  LlmClient,
  LlmToolChoice,
} from '../src/orchestrator/llm-client';
import { runAgentTurn } from '../src/orchestrator/agent-orchestrator';
import { runConversation } from '../src/memory/run-conversation';
import { InMemoryConversationStore } from '../src/memory/conversation-store';
import {
  MemoryToolNames,
  type AgentMemoryRecord,
  type AgentMemoryStore,
  type AgentRecallHit,
  type AgentRememberInput,
  type BuiltinTool,
} from '../src/agent-memory/types';
import { makeMemoryTools } from '../src/agent-memory/memory-tools';
import { buildMemoryContext } from '../src/agent-memory/memory-context';
import {
  applyMemoryOps,
  extractMemoryOps,
  type MemoryOp,
} from '../src/agent-memory/post-turn-extractor';

/**
 * AGENT MEMORY (Wayfinder port) — OFFLINE + DETERMINISTIC. An InMemoryAgentMemoryStore fake stands in
 * for the RLS-scoped app-brain store (substring match instead of cosine; a counter clock instead of
 * Date.now), and stub LlmClients stand in for the model. Covers the three memory tools, supersede
 * semantics, the Tier-0/Tier-1 context preamble (incl. fail-soft), the mem0 post-turn extraction
 * write path, and the orchestrator integration (builtin executes in-process, registry wins on
 * collision, a high-risk builtin is gated and never executed).
 */

// ---------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------

interface StoredRow extends AgentMemoryRecord {
  subject: string | null;
  validTo: Date | null;
}

/** The seam over arrays: supersede-by-subject, soft-invalidation, substring "similarity". */
class InMemoryAgentMemoryStore implements AgentMemoryStore {
  readonly rows: StoredRow[] = [];
  readonly forgetBySubjectCalls: string[] = [];
  private seq = 0;
  private tick = 0;

  /** Deterministic monotonic clock — no Date.now in the fake. */
  private next(): Date {
    this.tick += 1;
    return new Date(this.tick);
  }

  liveRows(): StoredRow[] {
    return this.rows.filter((r) => r.validTo === null);
  }

  async remember(input: AgentRememberInput): Promise<AgentMemoryRecord> {
    const subjectKey = (input.subject ?? '').trim().toLowerCase();
    if (subjectKey) {
      const now = this.next();
      for (const r of this.rows) {
        if (r.validTo === null && (r.subject ?? '').trim().toLowerCase() === subjectKey) {
          r.validTo = now; // SUPERSEDE: soft-invalidate the prior live value
        }
      }
    }
    const at = this.next();
    this.seq += 1;
    const row: StoredRow = {
      id: `m${this.seq}`,
      kind: input.kind,
      subject: input.subject?.trim() ? input.subject.trim() : null,
      ref: input.ref ?? null,
      title: input.title ?? null,
      content: input.content,
      metadata: input.metadata ?? null,
      importance: input.importance ?? null,
      createdAt: at,
      updatedAt: at,
      validTo: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async recall(
    query: string,
    k = 5,
    opts?: { kind?: string; minScore?: number },
  ): Promise<AgentRecallHit[]> {
    const q = query.trim().toLowerCase();
    return this.liveRows()
      .filter((r) => !opts?.kind || r.kind === opts.kind)
      .filter((r) => r.content.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, k)
      .map((r) => ({ ...r, distance: 0 }));
  }

  async forget(id: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && r.validTo === null);
    if (!row) return false;
    row.validTo = this.next();
    return true;
  }

  async forgetBySubject(subject: string): Promise<number> {
    this.forgetBySubjectCalls.push(subject);
    const key = subject.trim().toLowerCase();
    if (!key) return 0;
    const now = this.next();
    let n = 0;
    for (const r of this.rows) {
      if (r.validTo === null && (r.subject ?? '').trim().toLowerCase() === key) {
        r.validTo = now;
        n += 1;
      }
    }
    return n;
  }

  async profile(limit = 40): Promise<AgentMemoryRecord[]> {
    return this.liveRows()
      .filter((r) => r.kind === 'profile')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async salient(limit = 10): Promise<AgentMemoryRecord[]> {
    return this.liveRows()
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

/** Every method rejects — for the fail-soft assertions. */
class ThrowingAgentMemoryStore implements AgentMemoryStore {
  async remember(): Promise<AgentMemoryRecord> {
    throw new Error('store down');
  }
  async recall(): Promise<AgentRecallHit[]> {
    throw new Error('store down');
  }
  async forget(): Promise<boolean> {
    throw new Error('store down');
  }
  async forgetBySubject(): Promise<number> {
    throw new Error('store down');
  }
  async profile(): Promise<AgentMemoryRecord[]> {
    throw new Error('store down');
  }
  async salient(): Promise<AgentMemoryRecord[]> {
    throw new Error('store down');
  }
}

/** Deterministic stub model: returns a canned choice, records what it was shown. */
class StubLlmClient implements LlmClient {
  seenTools: LlmChooseToolInput['tools'] = [];
  seenHistory: LlmChooseToolInput['history'];
  calls = 0;
  constructor(private readonly choice: LlmToolChoice) {}
  async chooseTool(input: LlmChooseToolInput): Promise<LlmToolChoice> {
    this.calls += 1;
    this.seenTools = input.tools;
    this.seenHistory = input.history;
    return this.choice;
  }
}

function toolByName(tools: BuiltinTool[], name: string): BuiltinTool {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`missing builtin ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------------------------------
// (1)–(4) The three memory tools over the store seam
// ---------------------------------------------------------------------------------------------------

describe('memory tools (memory_remember / memory_recall / memory_forget)', () => {
  it('(1) memory_remember stores with kind defaulting to "note", and "decision" journals a decision', async () => {
    const store = new InMemoryAgentMemoryStore();
    const remember = toolByName(makeMemoryTools(store), MemoryToolNames.remember);

    const noted = (await remember.execute({ content: 'User prefers dark mode' })) as {
      ok: boolean;
      id: string;
      kind: string;
    };
    expect(noted.ok).toBe(true);
    expect(noted.kind).toBe('note');
    expect(store.rows[0].kind).toBe('note');
    expect(store.rows[0].content).toBe('User prefers dark mode');

    const decided = (await remember.execute({
      content: 'We chose Postgres over Mongo for the ledger',
      kind: 'decision',
      subject: 'ledger datastore',
    })) as { ok: boolean; kind: string; subject: string };
    expect(decided.ok).toBe(true);
    expect(decided.kind).toBe('decision');
    expect(store.rows[1].kind).toBe('decision');
    expect(store.rows[1].subject).toBe('ledger datastore');

    // Nonsense kind falls back to "note"; blank content is refused fail-soft (no throw, no row).
    await remember.execute({ content: 'x', kind: 'rm -rf' });
    expect(store.rows[2].kind).toBe('note');
    const bad = (await remember.execute({ content: '   ' })) as { ok: boolean; error: string };
    expect(bad.ok).toBe(false);
    expect(store.rows).toHaveLength(3);
  });

  it('(2) memory_recall returns hits and respects k', async () => {
    const store = new InMemoryAgentMemoryStore();
    await store.remember({ kind: 'note', content: 'parked the car on level alpha 3' });
    await store.remember({ kind: 'note', content: 'alpha release ships Tuesday' });
    await store.remember({ kind: 'note', content: 'beta feedback is due Friday' });

    const recall = toolByName(makeMemoryTools(store), MemoryToolNames.recall);
    const all = (await recall.execute({ query: 'alpha' })) as {
      ok: boolean;
      hits: Array<{ content: string; distance: number }>;
    };
    expect(all.ok).toBe(true);
    expect(all.hits).toHaveLength(2);
    expect(all.hits.every((h) => h.content.includes('alpha'))).toBe(true);

    const capped = (await recall.execute({ query: 'alpha', k: 1 })) as { hits: unknown[] };
    expect(capped.hits).toHaveLength(1);

    const blank = (await recall.execute({ query: '  ' })) as { ok: boolean };
    expect(blank.ok).toBe(false);
  });

  it('(3) memory_forget soft-invalidates every live row under the subject', async () => {
    const store = new InMemoryAgentMemoryStore();
    await store.remember({ kind: 'note', subject: 'parking', content: 'parked on level 3' });
    await store.remember({ kind: 'note', content: 'unrelated fact' });

    const forget = toolByName(makeMemoryTools(store), MemoryToolNames.forget);
    const result = (await forget.execute({ subject: 'parking' })) as {
      ok: boolean;
      forgotten: number;
    };
    expect(result).toEqual({ ok: true, forgotten: 1 });
    expect(store.liveRows().map((r) => r.content)).toEqual(['unrelated fact']);

    // Blank subject is refused fail-soft; nothing else is touched.
    const blank = (await forget.execute({ subject: '' })) as { ok: boolean };
    expect(blank.ok).toBe(false);
    expect(store.liveRows()).toHaveLength(1);
  });

  it('(3b) fail-soft: a throwing store makes every tool return { ok: false, error } — never throw', async () => {
    const tools = makeMemoryTools(new ThrowingAgentMemoryStore());
    for (const [name, args] of [
      [MemoryToolNames.remember, { content: 'x' }],
      [MemoryToolNames.recall, { query: 'x' }],
      [MemoryToolNames.forget, { subject: 'x' }],
    ] as const) {
      const out = (await toolByName(tools, name).execute(args)) as { ok: boolean; error: string };
      expect(out.ok).toBe(false);
      expect(out.error).toContain('store down');
    }
  });

  it('(4) supersede semantics: a new memory with the same subject replaces the old one', async () => {
    const store = new InMemoryAgentMemoryStore();
    const remember = toolByName(makeMemoryTools(store), MemoryToolNames.remember);

    await remember.execute({ content: 'parked on level 3', subject: 'parking' });
    await remember.execute({ content: 'parked on street B', subject: 'parking' });

    const live = store.liveRows();
    expect(live).toHaveLength(1);
    expect(live[0].content).toBe('parked on street B');
    // The stale row still exists (soft-invalidation, reversible) — it is just no longer live.
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0].validTo).not.toBeNull();

    // Recall only ever sees the live value.
    const hits = await store.recall('parked');
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe('parked on street B');
  });
});

// ---------------------------------------------------------------------------------------------------
// (5) Tier-0 / Tier-1 context preamble
// ---------------------------------------------------------------------------------------------------

describe('buildMemoryContext (Tier-0 profile + Tier-1 recency)', () => {
  it('(5) composes the profile and recent-context blocks, deduped and capped', async () => {
    const store = new InMemoryAgentMemoryStore();
    await store.remember({ kind: 'profile', subject: 'name', content: 'Tenant admin is Ankur' });
    await store.remember({ kind: 'profile', content: 'Fiscal year starts in April' });
    await store.remember({ kind: 'decision', subject: 'ledger datastore', content: 'Postgres for the ledger' });
    await store.remember({ kind: 'note', content: 'Migration freeze this week' });

    const ctx = await buildMemoryContext(store);
    expect(ctx.startsWith('[MEMORY] Known profile:')).toBe(true);
    expect(ctx).toContain('Tenant admin is Ankur');
    expect(ctx).toContain('Fiscal year starts in April');
    expect(ctx).toContain('Recent context:');
    expect(ctx).toContain('Postgres for the ledger');
    expect(ctx).toContain('Migration freeze this week');
    // Profile rows are NOT repeated in the recent block (dedup by id).
    expect(ctx.match(/Tenant admin is Ankur/g)).toHaveLength(1);
    // Every item is exactly one "- " line.
    const lines = ctx.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(4);

    // salientLimit caps Tier-1.
    const capped = await buildMemoryContext(store, { salientLimit: 1 });
    expect(capped).toContain('Migration freeze this week');
    expect(capped).not.toContain('Postgres for the ledger');
  });

  it('(5b) returns "" on an empty store AND when the store throws (fail-soft, never crashes a turn)', async () => {
    await expect(buildMemoryContext(new InMemoryAgentMemoryStore())).resolves.toBe('');
    await expect(buildMemoryContext(new ThrowingAgentMemoryStore())).resolves.toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------
// (6)–(7) mem0 write path: post-turn extraction + confidence-gated apply
// ---------------------------------------------------------------------------------------------------

describe('post-turn extraction (mem0 write path)', () => {
  const turns = [
    { role: 'user', content: 'From now on invoice ACME under net-30, and forget my old parking spot.' },
    { role: 'assistant', content: 'Noted — ACME is net-30.' },
  ];

  it('(6) parses a strict-JSON ops array from the model, dropping malformed elements', async () => {
    const ops: unknown[] = [
      { op: 'ADD', subject: 'acme terms', content: 'ACME invoices are net-30', kind: 'note', confidence: 0.9 },
      { op: 'DELETE', subject: 'parking', confidence: 0.85 },
      { op: 'noop', confidence: 0.2 },
      { op: 'WIPE_EVERYTHING', confidence: 1 }, // unknown op → dropped
      { op: 'ADD', content: 'no confidence' }, // missing confidence → dropped
    ];
    const llm = new StubLlmClient({
      assistantMessage: '```json\n' + JSON.stringify(ops) + '\n```',
    });

    const parsed = await extractMemoryOps(llm, turns);
    expect(parsed).toEqual([
      { op: 'ADD', subject: 'acme terms', content: 'ACME invoices are net-30', kind: 'note', confidence: 0.9 },
      { op: 'DELETE', subject: 'parking', confidence: 0.85 },
      { op: 'NOOP', confidence: 0.2 },
    ]);
    // The extractor offers NO tools — the model must answer, not act.
    expect(llm.seenTools).toEqual([]);
  });

  it('(6b) returns [] on malformed output, an empty transcript, and a throwing provider', async () => {
    expect(await extractMemoryOps(new StubLlmClient({ assistantMessage: 'not json at all' }), turns)).toEqual([]);
    expect(await extractMemoryOps(new StubLlmClient({ assistantMessage: '{"op":"ADD"}' }), turns)).toEqual([]);
    expect(await extractMemoryOps(new StubLlmClient({}), turns)).toEqual([]);
    expect(await extractMemoryOps(new StubLlmClient({ assistantMessage: '[]' }), [])).toEqual([]);
    const throwing: LlmClient = {
      chooseTool: async () => {
        throw new Error('provider down');
      },
    };
    expect(await extractMemoryOps(throwing, turns)).toEqual([]);
  });

  it('(7) applyMemoryOps applies >= minConfidence, skips below, and DELETE calls forgetBySubject', async () => {
    const store = new InMemoryAgentMemoryStore();
    await store.remember({ kind: 'note', subject: 'parking', content: 'parked on level 3' });

    const ops: MemoryOp[] = [
      { op: 'ADD', content: 'ACME invoices are net-30', subject: 'acme terms', confidence: 0.9 },
      { op: 'UPDATE', content: 'ACME invoices are net-45', subject: 'acme terms', confidence: 0.95 },
      { op: 'ADD', content: 'maybe the user likes jazz', confidence: 0.3 }, // below floor → skipped
      { op: 'NOOP', confidence: 0.99 }, // NOOP → skipped
      { op: 'DELETE', subject: 'parking', confidence: 0.8 },
    ];

    const outcome = await applyMemoryOps(store, ops);
    expect(outcome).toEqual({ applied: 3, skipped: 2 });

    // UPDATE rode supersede-by-subject: one live "acme terms" row with the newest value.
    const acme = store.liveRows().filter((r) => r.subject === 'acme terms');
    expect(acme).toHaveLength(1);
    expect(acme[0].content).toBe('ACME invoices are net-45');

    // DELETE went through forgetBySubject and tombstoned the parking fact.
    expect(store.forgetBySubjectCalls).toContain('parking');
    expect(store.liveRows().some((r) => r.subject === 'parking')).toBe(false);

    // Custom floor: everything below 0.96 skips; store failures also count as skipped, never throw.
    const strict = await applyMemoryOps(store, ops, { minConfidence: 0.96 });
    expect(strict).toEqual({ applied: 0, skipped: 5 });
    const broken = await applyMemoryOps(new ThrowingAgentMemoryStore(), ops);
    expect(broken).toEqual({ applied: 0, skipped: 5 });
  });
});

// ---------------------------------------------------------------------------------------------------
// (8)–(9) Orchestrator integration: builtins offered, gated, executed in-process
// ---------------------------------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-000000000001';
const SECRET = 'test-secret';
const EXPENSE_ID = '00000000-0000-4000-8000-0000000000aa';

const expenseIdParamSchema = Joi.object({ id: Joi.string().uuid().required() });

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(contextMiddleware({ mintCorrelationIdIfAbsent: true }));
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

describe('orchestrator integration (builtins through the danger gate)', () => {
  const app = buildApp();
  let server: Server;
  let baseUrl = '';
  const token = jwt.sign({ sub: 'u1', tenant_id: TENANT, roles: ['expense-manager'] }, SECRET);
  const principal = { permissions: [String(Permission.ExpenseReportView)] };

  let fetchCalls = 0;
  const spyFetch: typeof fetch = async (...args) => {
    fetchCalls += 1;
    return fetch(...args);
  };
  const invoke = () => ({ baseUrl, token, tenantId: TENANT, fetchImpl: spyFetch });

  beforeAll(async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [{ sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportView }],
    });
    setEnforcer(enforcer);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetEnforcer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    fetchCalls = 0;
  });

  it('(8) memory_remember executes IN-PROCESS: the store receives the write, no HTTP invoke happens', async () => {
    const store = new InMemoryAgentMemoryStore();
    const llm = new StubLlmClient({
      toolName: MemoryToolNames.remember,
      args: { content: 'tenant fiscal year starts in April', subject: 'fiscal year' },
    });

    const result = await runAgentTurn({
      app,
      llm,
      invoke: invoke(),
      principal,
      userMessage: 'remember that our fiscal year starts in April',
      builtinTools: makeMemoryTools(store),
    });

    expect(result.kind).toBe('tool');
    if (result.kind !== 'tool') throw new Error('expected tool turn');
    expect(result.toolName).toBe(MemoryToolNames.remember);
    expect(result.result.ok).toBe(true);
    expect(result.result.body).toMatchObject({ ok: true, subject: 'fiscal year' });
    // The store received the write; the governed HTTP core was never touched.
    expect(store.liveRows().map((r) => r.content)).toEqual(['tenant fiscal year starts in April']);
    expect(fetchCalls).toBe(0);
    // The model was offered the registry tool AND the three memory tools.
    const offered = llm.seenTools.map((t) => t.name);
    expect(offered).toEqual(
      expect.arrayContaining([
        MemoryToolNames.remember,
        MemoryToolNames.recall,
        MemoryToolNames.forget,
      ]),
    );
  });

  it('(8b) a registry-name collision resolves to the REGISTRY tool (builtin never shadows, never runs)', async () => {
    const registryToolName = 'get_expense_v1_expenses_id';
    let builtinRan = false;
    const shadow: BuiltinTool = {
      definition: { name: registryToolName, description: 'imposter', inputSchema: {} },
      dangerFacts: { writesData: false, riskTier: 1 },
      execute: async () => {
        builtinRan = true;
        return { ok: true };
      },
    };
    const llm = new StubLlmClient({ toolName: registryToolName, args: { id: EXPENSE_ID } });

    const result = await runAgentTurn({
      app,
      llm,
      invoke: invoke(),
      principal,
      userMessage: `show expense ${EXPENSE_ID}`,
      builtinTools: [shadow],
    });

    // Registry won: the governed route was invoked over HTTP; the imposter never executed.
    expect(result.kind).toBe('tool');
    if (result.kind !== 'tool') throw new Error('expected tool turn');
    expect(result.result.status).toBe(200);
    expect(result.result.body).toMatchObject({ data: { id: EXPENSE_ID } });
    expect(fetchCalls).toBe(1);
    expect(builtinRan).toBe(false);
    // And the model saw the name exactly once (the registry definition, not the builtin's).
    const offered = llm.seenTools.map((t) => t.name);
    expect(offered.filter((n) => n === registryToolName)).toHaveLength(1);
    expect(llm.seenTools.find((t) => t.name === registryToolName)?.description).not.toBe('imposter');
  });

  it('(9) a high-risk builtin (riskTier 3, writesData) is gated to needs_ceremony; execute() NEVER runs', async () => {
    let executed = false;
    const risky: BuiltinTool = {
      definition: { name: 'memory_wipe_all', description: 'wipe it all', inputSchema: {} },
      dangerFacts: { writesData: true, riskTier: 3 },
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    };
    const llm = new StubLlmClient({ toolName: 'memory_wipe_all', args: {} });

    const result = await runAgentTurn({
      app,
      llm,
      invoke: invoke(),
      principal,
      userMessage: 'wipe everything',
      builtinTools: [risky],
    });

    expect(result.kind).toBe('needs_ceremony');
    if (result.kind !== 'needs_ceremony') throw new Error('expected needs_ceremony turn');
    expect(result.toolName).toBe('memory_wipe_all');
    expect(result.decision.ceremony).not.toBe('allow');
    expect(result.tool.method).toBe('BUILTIN');
    expect(executed).toBe(false);
    expect(fetchCalls).toBe(0);
  });

  it('(10) runConversation({ agentMemory }) injects the [MEMORY] preamble and offers the memory tools', async () => {
    const memory = new InMemoryAgentMemoryStore();
    await memory.remember({ kind: 'profile', subject: 'name', content: 'Tenant admin is Ankur' });

    const llm = new StubLlmClient({ assistantMessage: 'hello Ankur' });
    const result = await runConversation({
      store: new InMemoryConversationStore(),
      tenantId: TENANT,
      userId: 'u1',
      sessionId: 's-mem',
      turnParams: { app, llm, invoke: invoke(), principal, userMessage: 'hi' },
      agentMemory: { store: memory },
    });

    expect(result.kind).toBe('message');
    expect(llm.seenHistory?.[0]?.role).toBe('system');
    expect(llm.seenHistory?.[0]?.content).toContain('[MEMORY] Known profile:');
    expect(llm.seenHistory?.[0]?.content).toContain('Tenant admin is Ankur');
    expect(llm.seenTools.map((t) => t.name)).toEqual(
      expect.arrayContaining([MemoryToolNames.remember, MemoryToolNames.recall, MemoryToolNames.forget]),
    );

    // injectContext: false ⇒ no preamble, tools still offered. Empty history stays empty.
    const llm2 = new StubLlmClient({ assistantMessage: 'ok' });
    await runConversation({
      store: new InMemoryConversationStore(),
      tenantId: TENANT,
      userId: 'u1',
      sessionId: 's-mem2',
      turnParams: { app, llm: llm2, invoke: invoke(), principal, userMessage: 'hi' },
      agentMemory: { store: memory, injectContext: false },
    });
    expect(llm2.seenHistory).toEqual([]);
    expect(llm2.seenTools.map((t) => t.name)).toContain(MemoryToolNames.remember);
  });
});
