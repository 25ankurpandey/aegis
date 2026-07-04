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
  generateToolRegistry,
  filterToolsForPrincipal,
  listToolsForPrincipal,
  invokeTool,
  type AegisTool,
} from '@aegis/ai-core';

/**
 * END-TO-END GOVERNED LOOP: an "agent" LISTS the tools it may use, then INVOKES one over HTTP — and the
 * request passes through the REAL chain (context → authenticate → authorize(Casbin PEP) → validate →
 * handler). This proves the whole thesis in code: the agent calls the same guarded route a human hits,
 * and the governed core allows/denies/validates — the agent cannot bypass it.
 *
 * A UUID tenant (context middleware requires X-Tenant-Id to be a UUID). AUTH_JWT_SECRET is set by
 * test/jest.setup.ts (matches the secret we sign tokens with below).
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

describe('governed tool loop (list → filter → invoke over HTTP)', () => {
  const app = buildApp();
  let server: Server;
  let baseUrl: string;
  let tools: AegisTool[];
  const managerToken = tokenFor(['expense-manager']);
  const viewerToken = tokenFor(['viewer']);

  const tool = (path: string, method: string) =>
    tools.find((t) => t.path === path && t.method === method)!;

  beforeAll(async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [
        { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportCreate },
        { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportView },
        { sub: 'viewer', dom: TENANT, act: Permission.ExpenseReportView },
      ],
    });
    setEnforcer(enforcer);
    tools = generateToolRegistry(app).tools;
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetEnforcer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('lists the authz-bound tools and filters them per principal', () => {
    expect(tools).toHaveLength(2);
    // A manager (holds both permissions) sees both tools; a viewer sees only the read tool.
    expect(
      listToolsForPrincipal(app, {
        permissions: [String(Permission.ExpenseReportCreate), String(Permission.ExpenseReportView)],
      }),
    ).toHaveLength(2);
    const viewerTools = filterToolsForPrincipal(tools, {
      permissions: [String(Permission.ExpenseReportView)],
    });
    expect(viewerTools.map((t) => t.method)).toEqual(['GET']);
  });

  it('INVOKES an allowed tool end-to-end and the governed core executes it (201)', async () => {
    const res = await invokeTool(
      tool('/expense/v1/expenses', 'POST'),
      { amount: 1500 },
      { baseUrl, token: managerToken, tenantId: TENANT },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ data: { created: true, amount: 1500 } });
  });

  it('is DENIED by the PEP when the principal lacks the permission (403) — no bypass', async () => {
    const res = await invokeTool(
      tool('/expense/v1/expenses', 'POST'),
      { amount: 1500 },
      { baseUrl, token: viewerToken, tenantId: TENANT }, // viewer cannot create
    );
    expect(res.status).toBe(403);
  });

  it('is REJECTED by validate() when the input is invalid (400)', async () => {
    const res = await invokeTool(
      tool('/expense/v1/expenses', 'POST'),
      { currency: 'USD' }, // missing required `amount`
      { baseUrl, token: managerToken, tenantId: TENANT },
    );
    expect(res.status).toBe(400);
  });

  it('substitutes path params and invokes a GET tool (200)', async () => {
    const id = '00000000-0000-4000-8000-0000000000aa';
    const res = await invokeTool(
      tool('/expense/v1/expenses/:id', 'GET'),
      { id },
      { baseUrl, token: managerToken, tenantId: TENANT },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: { id } });
  });

  it('fails authentication with a bad token (401) — the core rejects it', async () => {
    const res = await invokeTool(
      tool('/expense/v1/expenses/:id', 'GET'),
      { id: '00000000-0000-4000-8000-0000000000aa' },
      { baseUrl, token: 'not-a-real-jwt', tenantId: TENANT },
    );
    expect(res.status).toBe(401);
  });
});
