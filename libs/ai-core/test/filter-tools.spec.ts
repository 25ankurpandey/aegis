import { filterToolsForPrincipal } from '@aegis/ai-core';
import type { AegisTool, ToolFilterContext } from '@aegis/ai-core';

/**
 * The per-principal tool pre-filter: authorization×entitlement computed OUTSIDE the model, so the agent is
 * only ever offered tools the caller may use and the tenant is entitled to. Small inline fake tools keep
 * the intent obvious (we assert on the filter, not on the generator).
 */

// A minimal AegisTool factory — only the fields the filter reads (name + permissions) actually matter.
const tool = (name: string, permissions: string[]): AegisTool => ({
  name,
  method: 'GET',
  path: `/${name}`,
  permissions,
  requiresAuth: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  inputSources: [],
  description: `GET /${name}`,
});

describe('filterToolsForPrincipal (per-principal tool pre-filter)', () => {
  it('includes a tool when the caller holds a matching permission', () => {
    const tools = [tool('view_expense', ['expense.view'])];
    const ctx: ToolFilterContext = { permissions: ['expense.view'] };
    expect(filterToolsForPrincipal(tools, ctx).map((t) => t.name)).toEqual(['view_expense']);
  });

  it('excludes a tool when the caller lacks the required permission', () => {
    const tools = [tool('create_expense', ['expense.create'])];
    const ctx: ToolFilterContext = { permissions: ['expense.view'] };
    expect(filterToolsForPrincipal(tools, ctx)).toEqual([]);
  });

  it('includes a tool if the caller holds ANY one of several required permissions (authorizeAny)', () => {
    const tools = [tool('approve_expense', ['expense.approve', 'expense.admin'])];
    const ctx: ToolFilterContext = { permissions: ['expense.admin'] };
    expect(filterToolsForPrincipal(tools, ctx).map((t) => t.name)).toEqual(['approve_expense']);
  });

  it('excludes an otherwise-permitted tool when isModuleEnabled returns false (entitlement gate)', () => {
    const enabled = tool('view_expense', ['expense.view']);
    const disabled = tool('run_payroll', ['payroll.run']);
    const tools = [enabled, disabled];
    const ctx: ToolFilterContext = {
      permissions: ['expense.view', 'payroll.run'],
      isModuleEnabled: (t) => t.name !== 'run_payroll', // payroll module not entitled for this tenant
    };
    expect(filterToolsForPrincipal(tools, ctx).map((t) => t.name)).toEqual(['view_expense']);
  });

  it('yields an empty result when the caller holds no permissions', () => {
    const tools = [tool('view_expense', ['expense.view']), tool('create_expense', ['expense.create'])];
    const ctx: ToolFilterContext = { permissions: [] };
    expect(filterToolsForPrincipal(tools, ctx)).toEqual([]);
  });

  it('returns a new array and does not mutate the input', () => {
    const tools = [tool('view_expense', ['expense.view']), tool('create_expense', ['expense.create'])];
    const before = [...tools];
    const result = filterToolsForPrincipal(tools, { permissions: ['expense.view'] });
    expect(result).not.toBe(tools); // new array
    expect(tools).toEqual(before); // input untouched
    expect(tools).toHaveLength(2);
  });
});
