import express from 'express';
import Joi from 'joi';
import { authenticate, authorize } from '@aegis/access-control';
import { validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { generateToolRegistry, joiToJsonSchema } from '@aegis/ai-core';

/**
 * PROTOTYPE: prove the tool-registry generator against the REAL expense route definitions.
 * These schemas mirror apps/expense/src/validators/expense.validator.ts, and the routes are wired the
 * exact way apps/expense/src/controllers/expense.controller.ts wires them — real authenticate() +
 * authorize(Permission) + validate(schema). No expense DI graph is needed because the generator only
 * WALKS the registered routes; it never invokes the handlers.
 */

// Mirror of expense.validator.ts
const createExpenseSchema = Joi.object({
  amount: Joi.number().integer().required(), // integer minor units
  currency: Joi.string().length(3).optional(),
  merchant: Joi.string().optional(),
  incurredOn: Joi.string().isoDate().optional(),
  description: Joi.string().optional(),
  categoryId: Joi.string().uuid().optional(),
  receiptRef: Joi.string().optional(),
  reportId: Joi.string().uuid().optional(),
});
const expenseIdParamSchema = Joi.object({ id: Joi.string().uuid().required() });

function buildExpenseApp(): express.Application {
  const app = express();
  // POST /expense/api/v1/expenses  (create) — mirrors ExpenseController.createExpense
  app.post(
    '/expense/api/v1/expenses',
    authenticate(),
    authorize(Permission.ExpenseReportCreate),
    validate(createExpenseSchema),
    (_req, res) => res.sendStatus(201),
  );
  // GET /expense/api/v1/expenses/:id  (read) — mirrors ExpenseController.getExpense
  app.get(
    '/expense/api/v1/expenses/:id',
    authenticate(),
    authorize(Permission.ExpenseReportView),
    validate(expenseIdParamSchema, 'params'),
    (_req, res) => res.sendStatus(200),
  );
  // Unguarded infra route — MUST NOT become a tool.
  app.get('/health', (_req, res) => res.sendStatus(200));
  return app;
}

describe('tool-registry generator (expense prototype)', () => {
  const registry = generateToolRegistry(buildExpenseApp());
  const byPath = (p: string, m: string) =>
    registry.tools.find((t) => t.path === p && t.method === m)!;

  it('emits exactly one tool per guarded route and excludes unguarded infra routes', () => {
    expect(registry.tools).toHaveLength(2);
    expect(registry.tools.every((t) => t.requiresAuth)).toBe(true);
    expect(registry.tools.find((t) => t.path === '/health')).toBeUndefined();
  });

  it('binds each tool to the exact Permission the route requires (authz-bound)', () => {
    expect(byPath('/expense/api/v1/expenses', 'POST').permissions).toEqual([
      String(Permission.ExpenseReportCreate),
    ]);
    expect(byPath('/expense/api/v1/expenses/:id', 'GET').permissions).toEqual([
      String(Permission.ExpenseReportView),
    ]);
  });

  it('derives the POST input schema from the Joi body validator', () => {
    const tool = byPath('/expense/api/v1/expenses', 'POST');
    expect(tool.inputSources).toEqual(['body']);
    const s = tool.inputSchema;
    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['amount']); // only amount is required
    expect(s.properties?.amount).toEqual({ type: 'integer' });
    expect(s.properties?.currency).toMatchObject({ type: 'string', minLength: 3, maxLength: 3 });
    expect(s.properties?.categoryId).toMatchObject({ type: 'string', format: 'uuid' });
    expect(s.properties?.incurredOn).toMatchObject({ type: 'string', format: 'date-time' });
  });

  it('derives the GET input schema from the :id param validator', () => {
    const tool = byPath('/expense/api/v1/expenses/:id', 'GET');
    expect(tool.inputSources).toEqual(['params']);
    expect(tool.inputSchema.required).toEqual(['id']);
    expect(tool.inputSchema.properties?.id).toMatchObject({ type: 'string', format: 'uuid' });
  });

  it('gives every tool a deterministic name', () => {
    expect(byPath('/expense/api/v1/expenses', 'POST').name).toBe('post_expense_api_v1_expenses');
    expect(byPath('/expense/api/v1/expenses/:id', 'GET').name).toBe('get_expense_api_v1_expenses_id');
  });
});

describe('joiToJsonSchema (direct)', () => {
  it('maps enums, integers, and required flags', () => {
    const schema = Joi.object({
      status: Joi.string().valid('draft', 'submitted').required(),
      count: Joi.number().integer().min(0).optional(),
    });
    const js = joiToJsonSchema(schema);
    expect(js.properties?.status).toMatchObject({ type: 'string', enum: ['draft', 'submitted'] });
    expect(js.properties?.count).toMatchObject({ type: 'integer', minimum: 0 });
    expect(js.required).toEqual(['status']);
  });
});
