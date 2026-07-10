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
import type { LlmClient, LlmChooseToolInput, LlmToolChoice } from '../src/orchestrator/llm-client';
import { runConversation } from '../src/memory/run-conversation';
import {
  InMemoryConversationStore,
  sessionKey,
} from '../src/memory/conversation-store';

/**
 * TRACK 2 — conversation/session memory. Offline & deterministic, mirroring tool-loop.spec.ts: a real
 * governed mini-app (context → authenticate → authorize(PEP) → validate → handler), a stub LlmClient, and
 * an InMemoryConversationStore. We prove (a) history threads across turns, (b) it grows with user +
 * assistant/tool entries, (c) sessions are isolated, (d) clear empties a session.
 */
const TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-0000000000u1';
const USER_B = '00000000-0000-4000-8000-0000000000u2';
const SECRET = 'test-secret';

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

function tokenFor(roles: string[]): string {
  return jwt.sign({ sub: 'u1', tenant_id: TENANT, roles }, SECRET);
}

/** A stub LlmClient that records the history it was shown and returns a scripted choice per call. */
class ScriptedLlm implements LlmClient {
  readonly seenHistories: (LlmChooseToolInput['history'])[] = [];
  constructor(private readonly choices: LlmToolChoice[]) {}
  private call = 0;
  async chooseTool(input: LlmChooseToolInput): Promise<LlmToolChoice> {
    this.seenHistories.push(input.history);
    const choice = this.choices[Math.min(this.call, this.choices.length - 1)];
    this.call += 1;
    return choice;
  }
}

const READ_ID = '00000000-0000-4000-8000-0000000000aa';

describe('conversation/session memory (runConversation wraps runAgentTurn)', () => {
  const app = buildApp();
  let server: Server;
  let baseUrl: string;
  const token = tokenFor(['expense-manager']);

  const invoke = () => ({ baseUrl, token, tenantId: TENANT });
  const principal = { permissions: [String(Permission.ExpenseReportView)] };

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

  it('threads the 1st turn into the 2nd turn history (the model sees non-empty history on turn 2)', async () => {
    const store = new InMemoryConversationStore();
    const llm = new ScriptedLlm([
      { assistantMessage: 'hello there' },
      { assistantMessage: 'still here' },
    ]);

    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 's1',
      turnParams: { app, llm, invoke: invoke(), principal, userMessage: 'hi' },
    });
    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 's1',
      turnParams: { app, llm, invoke: invoke(), principal, userMessage: 'again' },
    });

    // Turn 1 saw empty history; turn 2 saw the recorded turn-1 exchange.
    expect(llm.seenHistories[0]).toEqual([]);
    expect(llm.seenHistories[1]).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ]);
  });

  it('grows history with user + assistant/tool entries (incl. a real governed tool call)', async () => {
    const store = new InMemoryConversationStore();
    const llm = new ScriptedLlm([
      { assistantMessage: 'sure' },
      { toolName: 'get_expense_v1_expenses_id', args: { id: READ_ID } },
    ]);

    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 's2',
      turnParams: { app, llm, invoke: invoke(), principal, userMessage: 'talk' },
    });
    const toolTurn = await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 's2',
      turnParams: { app, llm, invoke: invoke(), principal, userMessage: 'read it' },
    });

    // The 2nd turn actually invoked the governed GET route (200).
    expect(toolTurn.kind).toBe('tool');
    if (toolTurn.kind === 'tool') expect(toolTurn.result.status).toBe(200);

    const hist = store.history(sessionKey(TENANT, USER, 's2'));
    expect(hist).toHaveLength(4);
    expect(hist.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'tool']);
    expect(hist[0].content).toBe('talk');
    expect(hist[1].content).toBe('sure');
    expect(hist[2].content).toBe('read it');
    expect(hist[3].content).toContain('200');
    expect(hist[3].content).toContain('ok');
  });

  it('isolates history across sessions AND tenants (no cross-talk)', async () => {
    const store = new InMemoryConversationStore();
    const llmA = new ScriptedLlm([{ assistantMessage: 'A1' }, { assistantMessage: 'A2' }]);
    const llmOther = new ScriptedLlm([{ assistantMessage: 'X' }]);

    // Session s-a in TENANT (user USER) builds up two turns of history.
    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 's-a',
      turnParams: { app, llm: llmA, invoke: invoke(), principal, userMessage: 'a-hi' },
    });
    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 's-a',
      turnParams: { app, llm: llmA, invoke: invoke(), principal, userMessage: 'a-again' },
    });

    // A DIFFERENT session id in the same tenant/user sees empty history.
    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 's-b',
      turnParams: { app, llm: llmOther, invoke: invoke(), principal, userMessage: 'b-hi' },
    });
    expect(llmOther.seenHistories[0]).toEqual([]);

    // The SAME session id under a DIFFERENT tenant is also isolated.
    const llmTenantB = new ScriptedLlm([{ assistantMessage: 'Y' }]);
    await runConversation({
      store,
      tenantId: TENANT_B,
      userId: USER,
      sessionId: 's-a',
      turnParams: { app, llm: llmTenantB, invoke: invoke(), principal, userMessage: 'other-tenant' },
    });
    expect(llmTenantB.seenHistories[0]).toEqual([]);

    // The two isolated sessions/tenants left their own keys untouched by s-a.
    expect(store.history(sessionKey(TENANT, USER, 's-a'))).toHaveLength(4);
    expect(store.history(sessionKey(TENANT, USER, 's-b'))).toHaveLength(2);
    expect(store.history(sessionKey(TENANT_B, USER, 's-a'))).toHaveLength(2);
  });

  it('MEM-04: two DIFFERENT users with the SAME (tenantId, sessionId) do NOT see each other\'s history', async () => {
    const store = new InMemoryConversationStore();
    const llmA = new ScriptedLlm([{ assistantMessage: 'A-secret' }, { assistantMessage: 'A-more' }]);
    const llmB = new ScriptedLlm([{ assistantMessage: 'B-secret' }]);

    // User A holds a two-turn conversation on the SHARED session id.
    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 'shared-session',
      turnParams: { app, llm: llmA, invoke: invoke(), principal, userMessage: 'A-hi' },
    });
    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 'shared-session',
      turnParams: { app, llm: llmA, invoke: invoke(), principal, userMessage: 'A-again' },
    });

    // User B, SAME tenant, SAME sessionId, must start from an EMPTY history — no leak of A's transcript.
    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER_B,
      sessionId: 'shared-session',
      turnParams: { app, llm: llmB, invoke: invoke(), principal, userMessage: 'B-hi' },
    });
    expect(llmB.seenHistories[0]).toEqual([]);

    // The two users resolve to DIFFERENT keys and keep DISJOINT records.
    const keyA = sessionKey(TENANT, USER, 'shared-session');
    const keyB = sessionKey(TENANT, USER_B, 'shared-session');
    expect(keyA).not.toEqual(keyB);
    const histA = store.history(keyA);
    const histB = store.history(keyB);
    expect(histA).toHaveLength(4);
    expect(histB).toHaveLength(2);
    // Neither user's record contains the other's content.
    expect(histA.map((t) => t.content)).not.toContain('B-hi');
    expect(histA.map((t) => t.content)).not.toContain('B-secret');
    expect(histB.map((t) => t.content)).not.toContain('A-hi');
    expect(histB.map((t) => t.content)).not.toContain('A-secret');
  });

  it('MEM-04: sessionKey rejects a blank userId (user-less callers must pass a sentinel)', () => {
    expect(() => sessionKey(TENANT, '', 's-x')).toThrow(/userId is required/);
  });

  it('clear() empties a session', async () => {
    const store = new InMemoryConversationStore();
    const llm = new ScriptedLlm([{ assistantMessage: 'gone soon' }]);
    await runConversation({
      store,
      tenantId: TENANT,
      userId: USER,
      sessionId: 's-clear',
      turnParams: { app, llm, invoke: invoke(), principal, userMessage: 'hi' },
    });
    const key = sessionKey(TENANT, USER, 's-clear');
    expect(store.history(key).length).toBeGreaterThan(0);
    store.clear(key);
    expect(store.history(key)).toEqual([]);
  });
});
