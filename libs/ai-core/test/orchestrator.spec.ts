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
import { listToolsForPrincipal } from '@aegis/ai-core';
import {
  runAgentTurn,
  type AegisTurnResult,
} from '../src/orchestrator/agent-orchestrator';
import type {
  LlmChooseToolInput,
  LlmClient,
  LlmToolChoice,
} from '../src/orchestrator/llm-client';
import { OpenAiCompatibleLlmClient } from '../src/orchestrator/openai-compatible-client';
import { deriveDangerFacts } from '../src/orchestrator/derive-danger-facts';
import type { AegisTool } from '../src/tool-registry/types';

/**
 * The AGENT ORCHESTRATOR over the SAME mini governed app as the tool loop (context → authenticate →
 * authorize(PEP) → validate → handler). A STUB LlmClient stands in for the model — deterministic and
 * offline — so we assert the orchestrator's control flow: it offers only the filtered tools, invokes an
 * offered tool through the governed core, relays a plain reply, refuses any tool outside the offer, and
 * — the ENFORCED 2nd axis — surfaces a write / dangerous action as `needs_ceremony` (server-derived
 * facts) instead of auto-executing it. A low-danger READ auto-runs; a write is never auto-invoked.
 */
const TENANT = '00000000-0000-4000-8000-000000000001';
const SECRET = 'test-secret';

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

/** A deterministic stub model: returns a canned choice and records what tools it was shown. */
class StubLlmClient implements LlmClient {
  seenTools: LlmChooseToolInput['tools'] = [];
  calls = 0;
  constructor(private readonly choice: LlmToolChoice) {}
  async chooseTool(input: LlmChooseToolInput): Promise<LlmToolChoice> {
    this.calls += 1;
    this.seenTools = input.tools;
    return this.choice;
  }
}

describe('agent orchestrator (list → LLM chooses → invoke through the governed core)', () => {
  const app = buildApp();
  let server: Server;
  let baseUrl: string;
  const managerToken = tokenFor(['expense-manager']);
  const viewerToken = tokenFor(['viewer']);
  const createToolName = () =>
    listToolsForPrincipal(app, {
      permissions: [String(Permission.ExpenseReportCreate)],
    }).find((t) => t.method === 'POST')!.name;
  const readToolName = () =>
    listToolsForPrincipal(app, {
      permissions: [String(Permission.ExpenseReportView)],
    }).find((t) => t.method === 'GET')!.name;

  beforeAll(async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [
        { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportCreate },
        { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportView },
        { sub: 'viewer', dom: TENANT, act: Permission.ExpenseReportView },
      ],
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

  const EXPENSE_ID = '00000000-0000-4000-8000-0000000000aa';

  it('(i) allow: a low-danger READ auto-executes through the governed core (kind "tool", 200)', async () => {
    // A GET read derives verbClass "read" ⇒ danger level 0 ⇒ ceremony "allow" ⇒ invoked as today.
    const llm = new StubLlmClient({ toolName: readToolName(), args: { id: EXPENSE_ID } });
    const result = await runAgentTurn({
      app,
      llm,
      invoke: { baseUrl, token: managerToken, tenantId: TENANT },
      principal: { permissions: [String(Permission.ExpenseReportView)] },
      userMessage: `show me expense ${EXPENSE_ID}`,
    });
    expect(result.kind).toBe('tool');
    if (result.kind !== 'tool') throw new Error('expected tool turn');
    expect(result.toolName).toBe(readToolName());
    expect(result.result.status).toBe(200);
    expect(result.result.body).toMatchObject({ data: { id: EXPENSE_ID } });
  });

  it('(i-b) needs_ceremony: even a small write (create) is surfaced, NEVER auto-invoked', async () => {
    // A POST create derives verbClass "create" ⇒ danger level ≥ 1 ⇒ NOT "allow": surfaced, no HTTP call.
    let fetchCalls = 0;
    const spyFetch: typeof fetch = async (...args) => {
      fetchCalls += 1;
      return fetch(...args);
    };
    const llm = new StubLlmClient({ toolName: createToolName(), args: { amount: 1500 } });
    const result = await runAgentTurn({
      app,
      llm,
      invoke: { baseUrl, token: managerToken, tenantId: TENANT, fetchImpl: spyFetch },
      principal: { permissions: [String(Permission.ExpenseReportCreate)] },
      userMessage: 'file a $1500 expense',
    });
    expect(result.kind).toBe('needs_ceremony');
    if (result.kind !== 'needs_ceremony') throw new Error('expected needs_ceremony turn');
    expect(result.toolName).toBe(createToolName());
    expect(result.args).toEqual({ amount: 1500 });
    expect(result.decision.ceremony).not.toBe('allow');
    expect(fetchCalls).toBe(0);
  });

  it('(ii) relays a natural-language reply when the model does not call a tool', async () => {
    const llm = new StubLlmClient({ assistantMessage: 'I can help with expenses.' });
    const result: AegisTurnResult = await runAgentTurn({
      app,
      llm,
      invoke: { baseUrl, token: managerToken, tenantId: TENANT },
      principal: { permissions: [String(Permission.ExpenseReportCreate)] },
      userMessage: 'hello',
    });
    expect(result.kind).toBe('message');
    if (result.kind !== 'message') throw new Error('expected message turn');
    expect(result.text).toBe('I can help with expenses.');
  });

  it('(iii) refuses a tool not in the offered set and makes NO HTTP call', async () => {
    let fetchCalls = 0;
    const spyFetch: typeof fetch = async (...args) => {
      fetchCalls += 1;
      return fetch(...args);
    };
    const llm = new StubLlmClient({ toolName: 'delete_the_database', args: {} });
    const result = await runAgentTurn({
      app,
      llm,
      invoke: { baseUrl, token: managerToken, tenantId: TENANT, fetchImpl: spyFetch },
      principal: { permissions: [String(Permission.ExpenseReportCreate)] },
      userMessage: 'drop everything',
    });
    expect(result.kind).toBe('refused');
    expect(fetchCalls).toBe(0);
  });

  it('(iv) never offers a tool the principal lacks permission for', async () => {
    // A viewer can only view — the create tool must not even be shown to the model.
    const llm = new StubLlmClient({ assistantMessage: 'ok' });
    await runAgentTurn({
      app,
      llm,
      invoke: { baseUrl, token: viewerToken, tenantId: TENANT },
      principal: { permissions: [String(Permission.ExpenseReportView)] },
      userMessage: 'what can you do',
    });
    const offeredNames = llm.seenTools.map((t) => t.name);
    expect(offeredNames).not.toContain(createToolName());
    // and the only offered tool is the read tool
    expect(llm.seenTools).toHaveLength(1);
  });

  it('(v) needs_ceremony: a high-amount create requires a HUMAN and makes NO HTTP call', async () => {
    // $100k+ (≥ 10_000_000 minor) ⇒ danger level ≥ 4 ⇒ second_approver ⇒ requiresHuman, nothing invoked.
    let fetchCalls = 0;
    const spyFetch: typeof fetch = async (...args) => {
      fetchCalls += 1;
      return fetch(...args);
    };
    const llm = new StubLlmClient({ toolName: createToolName(), args: { amount: 100_000_00 } });
    const result = await runAgentTurn({
      app,
      llm,
      invoke: { baseUrl, token: managerToken, tenantId: TENANT, fetchImpl: spyFetch },
      principal: { permissions: [String(Permission.ExpenseReportCreate)] },
      userMessage: 'file a $100,000 expense',
    });
    expect(result.kind).toBe('needs_ceremony');
    if (result.kind !== 'needs_ceremony') throw new Error('expected needs_ceremony turn');
    expect(result.decision.requiresHuman).toBe(true);
    expect(result.decision.ceremony).toBe('second_approver');
    // approverPoolSize defaulted undefined ⇒ single-human fail-safe (out-of-band + review queue).
    expect(result.decision.requiresOutOfBand).toBe(true);
    expect(result.decision.reviewQueue).toBe(true);
    // No approvals gateway supplied ⇒ no handle attached, and NOTHING was invoked.
    expect(result.approval).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  it('(vi) deriveDangerFacts maps HTTP method + args deterministically (no model input)', async () => {
    const del: AegisTool = {
      name: 'delete_expense',
      method: 'DELETE',
      path: '/expense/v1/expenses/:id',
      permissions: [],
      requiresAuth: true,
      inputSchema: {},
      inputSources: [],
      description: '',
    };
    const delFacts = deriveDangerFacts(del, { ids: ['a', 'b', 'c'] });
    expect(delFacts).toMatchObject({
      verbClass: 'delete',
      resourceClass: 'expenses',
      irreversible: true,
      count: 3,
    });

    const post: AegisTool = { ...del, name: 'p', method: 'POST', path: '/expense/v1/expenses' };
    const postFacts = deriveDangerFacts(post, { amount: 2500, currency: 'usd' });
    expect(postFacts).toMatchObject({
      verbClass: 'create',
      resourceClass: 'expenses',
      irreversible: false,
      amountMinor: 2500,
    });
    expect(postFacts.count).toBeUndefined();

    const get: AegisTool = { ...del, name: 'g', method: 'GET', path: '/expense/v1/expenses/:id' };
    expect(deriveDangerFacts(get, { id: 'x' })).toMatchObject({
      verbClass: 'read',
      resourceClass: 'expenses',
      irreversible: false,
    });
  });
});

describe('OpenAiCompatibleLlmClient (offline, canned fetch)', () => {
  const tool = { name: 'post_expense_v1_expenses', description: 'create expense', inputSchema: {} };

  it('parses a tool_call into toolName + args, and a content-only reply into assistantMessage', async () => {
    const toolCallFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'post_expense_v1_expenses',
                      arguments: JSON.stringify({ amount: 42 }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const toolClient = new OpenAiCompatibleLlmClient({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'k',
      model: 'gpt-test',
      fetchImpl: toolCallFetch,
    });
    const toolChoice = await toolClient.chooseTool({ userMessage: 'file 42', tools: [tool] });
    expect(toolChoice.toolName).toBe('post_expense_v1_expenses');
    expect(toolChoice.args).toEqual({ amount: 42 });

    const contentFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi there' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const contentClient = new OpenAiCompatibleLlmClient({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'k',
      model: 'gpt-test',
      fetchImpl: contentFetch,
    });
    const messageChoice = await contentClient.chooseTool({ userMessage: 'hello', tools: [tool] });
    expect(messageChoice.toolName).toBeUndefined();
    expect(messageChoice.assistantMessage).toBe('hi there');
  });
});
