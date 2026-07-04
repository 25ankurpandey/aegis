import express from 'express';
import Joi from 'joi';
import { authenticate, authorize } from '@aegis/access-control';
import { validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { generateToolRegistry } from '../src/tool-registry/generate-tool-registry';
import {
  applyToolManifest,
  improveDescription,
  toolKey,
  type ToolManifest,
} from '../src/tool-registry/tool-manifest';
import type { AegisTool } from '../src/tool-registry/types';

/**
 * Proves the AI-Native Module Contract: a per-service manifest replaces the generated placeholder
 * description with an intent-shaped phrase and can attach riskTier/tags — and that WITHOUT a manifest
 * the default is the improved imperative phrase (never the raw "METHOD path").
 */

const createExpenseSchema = Joi.object({ amount: Joi.number().integer().required() });
const expenseIdParamSchema = Joi.object({ id: Joi.string().uuid().required() });

function buildExpenseApp(): express.Application {
  const app = express();
  app.post(
    '/expense/api/v1/expenses',
    authenticate(),
    authorize(Permission.ExpenseReportCreate),
    validate(createExpenseSchema),
    (_req, res) => res.sendStatus(201),
  );
  app.get(
    '/expense/api/v1/expenses/:id',
    authenticate(),
    authorize(Permission.ExpenseReportView),
    validate(expenseIdParamSchema, 'params'),
    (_req, res) => res.sendStatus(200),
  );
  return app;
}

function stubTool(method: string, path: string): AegisTool {
  return {
    name: 'stub',
    method: method.toUpperCase(),
    path,
    permissions: ['p'],
    requiresAuth: true,
    inputSchema: { type: 'object' },
    inputSources: [],
    description: `${method.toUpperCase()} ${path}`,
  };
}

describe('generateToolRegistry with a manifest', () => {
  const manifest: ToolManifest = {
    'POST /expense/api/v1/expenses': {
      description: 'File a new expense for reimbursement',
      riskTier: 3,
      tags: ['expense', 'write'],
    },
  };
  const registry = generateToolRegistry(buildExpenseApp(), { manifest });
  const post = registry.tools.find((t) => t.method === 'POST')!;
  const get = registry.tools.find((t) => t.method === 'GET')!;

  it('(a) carries the manifest description + riskTier + tags on the matched tool', () => {
    expect(post.description).toBe('File a new expense for reimbursement');
    expect(post.riskTier).toBe(3);
    expect(post.tags).toEqual(['expense', 'write']);
  });

  it('falls back to the improved default when the manifest has no entry', () => {
    expect(get.description).toBe('Get an expense by id');
    expect(get.riskTier).toBeUndefined();
    expect(get.tags).toBeUndefined();
  });
});

describe('generateToolRegistry without a manifest', () => {
  const registry = generateToolRegistry(buildExpenseApp());

  it('(b) uses the improved imperative phrase, not the raw "METHOD path"', () => {
    const post = registry.tools.find((t) => t.method === 'POST')!;
    const get = registry.tools.find((t) => t.method === 'GET')!;
    expect(post.description).toBe('Create an expense');
    expect(get.description).toBe('Get an expense by id');
    expect(post.description).not.toBe('POST /expense/api/v1/expenses');
  });
});

describe('applyToolManifest', () => {
  it('(c) returns a new object and does not mutate the input', () => {
    const input = stubTool('POST', '/expense/v1/expenses');
    const manifest: ToolManifest = {
      [toolKey('POST', '/expense/v1/expenses')]: {
        description: 'Create an expense',
        riskTier: 2,
        tags: ['x'],
      },
    };
    const out = applyToolManifest(input, manifest);
    expect(out).not.toBe(input);
    expect(out.description).toBe('Create an expense');
    expect(out.riskTier).toBe(2);
    expect(out.tags).toEqual(['x']);
    // input untouched
    expect(input.description).toBe('POST /expense/v1/expenses');
    expect(input.riskTier).toBeUndefined();
    expect(input.tags).toBeUndefined();
  });

  it('returns an unchanged copy when no manifest entry matches', () => {
    const input = stubTool('GET', '/expense/v1/expenses/:id');
    const out = applyToolManifest(input, { 'POST /other': { description: 'x' } });
    expect(out).not.toBe(input);
    expect(out.description).toBe(input.description);
    expect(out.riskTier).toBeUndefined();
  });

  it('leaves fields absent from the entry unchanged', () => {
    const input = stubTool('POST', '/a');
    const out = applyToolManifest(input, { 'POST /a': { riskTier: 4 } });
    expect(out.riskTier).toBe(4);
    expect(out.description).toBe('POST /a'); // description not in entry -> unchanged
  });
});

describe('improveDescription verb mapping', () => {
  it('(d) maps POST/GET/PUT/DELETE correctly', () => {
    expect(improveDescription('POST', '/expense/v1/expenses')).toBe('Create an expense');
    expect(improveDescription('GET', '/expense/v1/expenses/:id')).toBe('Get an expense by id');
    expect(improveDescription('PUT', '/expense/v1/expenses/:id')).toBe('Update an expense by id');
    expect(improveDescription('DELETE', '/expense/v1/expenses/:id')).toBe('Delete an expense by id');
    expect(improveDescription('GET', '/expense/v1/reports')).toBe('Get a report');
  });
});
