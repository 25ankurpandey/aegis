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
import { generateToolRegistry } from '../src/tool-registry/generate-tool-registry';
import type { AegisTool } from '../src/tool-registry/types';
import type { InvokeContext } from '../src/tool-server/tool-server';
import {
  SupervisedActionBroker,
  InMemoryPendingActionStore,
} from '../src/execution/supervised-action-broker';

/**
 * The SUPERVISED ACTION BROKER end-to-end over the SAME governed mini-app as the tool loop: propose runs
 * an `allow` (read) straight through the guarded route; a danger-gated write returns `needs_ceremony`
 * WITHOUT ever touching HTTP; confirm executes the persisted action only once the human's ceremony (and,
 * for a material write, the verifier) is satisfied, and then the pending action is gone.
 */
const TENANT = '00000000-0000-4000-8000-000000000001';
const SECRET = 'test-secret';

const createExpenseSchema = Joi.object({
  amount: Joi.number().integer().optional(),
  items: Joi.array().items(Joi.string()).optional(),
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
    (req, res) => res.status(201).json({ data: { created: true, items: req.body.items ?? null } }),
  );
  app.get(
    '/expense/v1/expenses/:id',
    authenticate(),
    authorize(Permission.ExpenseReportView),
    validate(expenseIdParamSchema, 'params'),
    (req, res) => res.status(200).json({ data: { id: req.params.id } }),
  );
  app.delete(
    '/expense/v1/expenses/:id',
    authenticate(),
    authorize(Permission.ExpenseReportCreate),
    validate(expenseIdParamSchema, 'params'),
    (req, res) => res.status(200).json({ data: { deleted: req.params.id } }),
  );
  app.use(errorMiddleware);
  return app;
}

function tokenFor(roles: string[]): string {
  return jwt.sign({ sub: 'u1', tenant_id: TENANT, roles }, SECRET);
}

describe('SupervisedActionBroker (propose → confirm, two-step governed flow)', () => {
  const app = buildApp();
  let server: Server;
  let baseUrl: string;
  let tools: AegisTool[];
  let invoke: InvokeContext;
  const managerToken = tokenFor(['expense-manager']);

  const tool = (path: string, method: string) =>
    tools.find((t) => t.path === path && t.method === method)!;

  beforeAll(async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [
        { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportCreate },
        { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportView },
      ],
    });
    setEnforcer(enforcer);
    tools = generateToolRegistry(app).tools;
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    invoke = { baseUrl, token: managerToken, tenantId: TENANT };
  });

  afterAll(async () => {
    resetEnforcer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const newBroker = (idFactory?: () => string) =>
    new SupervisedActionBroker({ store: new InMemoryPendingActionStore(), idFactory });

  it('(a) propose an ALLOW (read) tool ⇒ status "allow" + the governed result (executed over HTTP)', async () => {
    const broker = newBroker();
    const id = '00000000-0000-4000-8000-0000000000aa';
    const res = await broker.propose({
      tool: tool('/expense/v1/expenses/:id', 'GET'),
      args: { id },
      invoke,
      gateContext: { approverPoolSize: undefined },
    });
    expect(res.status).toBe('allow');
    if (res.status !== 'allow') throw new Error('unreachable');
    expect(res.result.status).toBe(200);
    expect(res.result.body).toMatchObject({ data: { id } });
  });

  it('(b) propose a WRITE (bulk create ⇒ confirm) ⇒ needs_ceremony + pendingId, and NO HTTP invoke happened', async () => {
    // A fetch spy proves propose never reaches the guarded route for a gated write.
    const fetchSpy = jest.fn();
    const broker = newBroker(() => 'pending-b');
    const res = await broker.propose({
      tool: tool('/expense/v1/expenses', 'POST'),
      args: { items: ['a', 'b'] }, // count=2 ⇒ level 1 ⇒ confirm; no money/irreversible ⇒ reversible
      invoke: { ...invoke, fetchImpl: fetchSpy as unknown as typeof fetch },
      gateContext: { approverPoolSize: undefined },
    });
    expect(res.status).toBe('needs_ceremony');
    if (res.status !== 'needs_ceremony') throw new Error('unreachable');
    expect(res.pendingId).toBe('pending-b');
    expect(res.decision.ceremony).toBe('confirm');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('(c) confirm with valid ceremony (+ passing verifier for a material write) ⇒ executed + governed result, pending deleted', async () => {
    const store = new InMemoryPendingActionStore();
    const broker = new SupervisedActionBroker({ store, idFactory: () => 'pending-c' });
    const id = '00000000-0000-4000-8000-0000000000cc';

    // DELETE single row ⇒ irreversible ⇒ step_up ceremony + MATERIAL blast (needs the verifier).
    const proposed = await broker.propose({
      tool: tool('/expense/v1/expenses/:id', 'DELETE'),
      args: { id },
      invoke,
      gateContext: { approverPoolSize: undefined },
    });
    expect(proposed.status).toBe('needs_ceremony');
    if (proposed.status !== 'needs_ceremony') throw new Error('unreachable');
    expect(proposed.decision.ceremony).toBe('step_up');

    const res = await broker.confirm({
      pendingId: 'pending-c',
      evidence: { stepUp: { verified: true } },
      verify: {
        deterministic: true,
        deterministicRecheck: async () => ({ value: 'ok' }),
        expected: 'ok',
        independent: {
          verify: async () => ({ verified: true, methods: ['dual_control'], reasons: ['stub verifier approved'] }),
        },
        proposerModelId: 'proposer-model',
      },
    });
    expect(res.executed).toBe(true);
    expect(res.result?.status).toBe(200);
    expect(res.result?.body).toMatchObject({ data: { deleted: id } });
    // Executed ⇒ the pending action is consumed and cannot be replayed.
    expect(await store.get('pending-c')).toBeUndefined();
  });

  it('(d) confirm with bad/absent ceremony ⇒ executed:false and the pending action REMAINS', async () => {
    const store = new InMemoryPendingActionStore();
    const broker = new SupervisedActionBroker({ store, idFactory: () => 'pending-d' });
    const fetchSpy = jest.fn();

    await broker.propose({
      tool: tool('/expense/v1/expenses', 'POST'),
      args: { items: ['a', 'b'] }, // ⇒ confirm ceremony
      invoke: { ...invoke, fetchImpl: fetchSpy as unknown as typeof fetch },
      gateContext: { approverPoolSize: undefined },
    });

    const res = await broker.confirm({ pendingId: 'pending-d', evidence: {} }); // no confirmedAt/confirmed
    expect(res.executed).toBe(false);
    expect(res.refusedReason).toMatch(/ceremony not satisfied/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Fail-closed but retryable: the pending action is still there for a later valid confirm.
    expect(await store.get('pending-d')).toBeDefined();
  });

  it('(e) confirm an UNKNOWN pendingId ⇒ a clear refusal (executed:false), no throw', async () => {
    const broker = newBroker();
    const res = await broker.confirm({ pendingId: 'does-not-exist', evidence: { confirmed: true } });
    expect(res.executed).toBe(false);
    expect(res.refusedReason).toMatch(/no pending action/i);
  });
});
