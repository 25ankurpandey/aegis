import { validateToolRegistry } from '../src/tool-registry/registry-validation';
import type { AegisTool, ToolRegistry } from '../src/tool-registry/types';

/**
 * The CI DRIFT GATE: a module must not ship a tool that is ungoverned, undescribed, or (for a write)
 * un-tiered. These tests construct ToolRegistry objects inline and assert the validator's verdicts, plus
 * its determinism (same input → deep-equal result).
 */

function makeTool(over: Partial<AegisTool> = {}): AegisTool {
  return {
    name: 'get_expense_v1_expenses',
    method: 'GET',
    path: '/expense/v1/expenses',
    permissions: ['expense:view'],
    requiresAuth: true,
    inputSchema: { type: 'object', properties: {} },
    inputSources: ['query'],
    description: 'List expense reports for the current tenant.',
    ...over,
  };
}

describe('validateToolRegistry (CI drift gate)', () => {
  it('a clean registry is ok with zero errors', () => {
    const registry: ToolRegistry = {
      tools: [
        makeTool({ name: 'get_expenses', description: 'List expense reports.' }),
        makeTool({
          name: 'post_expenses',
          method: 'POST',
          path: '/expense/v1/expenses',
          permissions: ['expense:create'],
          inputSources: ['body'],
          description: 'Create a new expense report.',
          riskTier: 2,
        }),
      ],
    };
    const result = validateToolRegistry(registry);
    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it('flags a placeholder ("METHOD /path") description as an error', () => {
    const registry: ToolRegistry = { tools: [makeTool({ description: 'POST /x' })] };
    const result = validateToolRegistry(registry);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'placeholder_description' && i.severity === 'error')).toBe(true);
  });

  it('flags an empty description as an error', () => {
    const registry: ToolRegistry = { tools: [makeTool({ description: '   ' })] };
    const result = validateToolRegistry(registry);
    expect(result.issues.some((i) => i.code === 'placeholder_description' && i.severity === 'error')).toBe(true);
  });

  it('flags empty permissions as an error (not authz-bound)', () => {
    const registry: ToolRegistry = { tools: [makeTool({ permissions: [] })] };
    const result = validateToolRegistry(registry);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'no_permissions' && i.severity === 'error')).toBe(true);
  });

  it('flags duplicate tool names as an error', () => {
    const registry: ToolRegistry = {
      tools: [makeTool({ name: 'dup' }), makeTool({ name: 'dup' })],
    };
    const result = validateToolRegistry(registry);
    expect(result.ok).toBe(false);
    const dups = result.issues.filter((i) => i.code === 'duplicate_name' && i.severity === 'error');
    expect(dups).toHaveLength(1);
    expect(dups[0].toolName).toBe('dup');
  });

  it('flags a missing inputSchema as an error', () => {
    const registry: ToolRegistry = {
      tools: [makeTool({ inputSchema: undefined as unknown as AegisTool['inputSchema'] })],
    };
    const result = validateToolRegistry(registry);
    expect(result.issues.some((i) => i.code === 'missing_input_schema' && i.severity === 'error')).toBe(true);
  });

  it('warns on a mutating tool with no riskTier — and errors under requireRiskTier', () => {
    const registry: ToolRegistry = {
      tools: [
        makeTool({
          name: 'post_expenses',
          method: 'POST',
          permissions: ['expense:create'],
          description: 'Create an expense report.',
        }),
      ],
    };

    const warned = validateToolRegistry(registry);
    expect(warned.ok).toBe(true);
    expect(warned.errors).toBe(0);
    const warn = warned.issues.find((i) => i.code === 'mutating_tool_missing_risk_tier');
    expect(warn?.severity).toBe('warn');

    const strict = validateToolRegistry(registry, { requireRiskTier: true });
    expect(strict.ok).toBe(false);
    const err = strict.issues.find((i) => i.code === 'mutating_tool_missing_risk_tier');
    expect(err?.severity).toBe('error');
  });

  it('warns on a delete/irreversible tool with riskTier < 3', () => {
    const registry: ToolRegistry = {
      tools: [
        makeTool({
          name: 'delete_expenses',
          method: 'DELETE',
          path: '/expense/v1/expenses/:id',
          permissions: ['expense:delete'],
          inputSources: ['params'],
          description: 'Delete an expense report.',
          riskTier: 2,
        }),
      ],
    };
    const result = validateToolRegistry(registry);
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.code === 'irreversible_tool_low_risk_tier' && i.severity === 'warn')).toBe(true);
  });

  it('is deterministic — same input yields a deep-equal result', () => {
    const registry: ToolRegistry = {
      tools: [
        makeTool({ description: 'POST /x' }),
        makeTool({ name: 'post_x', method: 'POST', permissions: [], description: 'Create.' }),
        makeTool({ name: 'post_x', method: 'POST', permissions: ['x:create'], description: 'Create.' }),
      ],
    };
    expect(validateToolRegistry(registry)).toEqual(validateToolRegistry(registry));
  });
});
