import { Permission } from '@aegis/shared-enums';
import {
  mapPolicyRow,
  mapPolicyRows,
  parseRuleEnvelope,
  policyActionOf,
  validatePolicyWrite,
  type PolicyRow,
} from '../src/policy-row-mapper';

/**
 * Phase-0 unit tests for the pure `PolicyRow -> PolicyRule | MappingError` mapper
 * (docs/strategy/abac-generalization.md §3 Q1/Q8, §5 Phase 0, §6 test matrix).
 */

const rowOf = (over: Partial<PolicyRow> = {}): PolicyRow => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  tenant_id: 't1',
  permission: Permission.ExpenseReportApprove,
  effect: 'deny',
  rule: { conditions: [{ attribute: 'resource.amount', operator: 'gt', value: 50_000 }] },
  priority: 100,
  is_active: true,
  ...over,
});

describe('policy-row-mapper: single-row mapping', () => {
  it('maps a valid row field-by-field (permission -> action, tenant_id -> tenantId)', () => {
    const result = mapPolicyRow(rowOf());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule).toEqual({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      tenantId: 't1',
      effect: 'deny',
      action: Permission.ExpenseReportApprove,
      conditions: [{ attribute: 'resource.amount', operator: 'gt', value: 50_000 }],
    });
    expect(result.warning).toBeUndefined();
  });

  it('rejects a permission that is not a known Permission value', () => {
    const result = mapPolicyRow(rowOf({ permission: 'expense.report.frobnicate' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.rowId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(result.error.permission).toBe('expense.report.frobnicate');
    expect(result.error.reason).toContain('not a known Permission');
  });

  it('rejects an effect outside allow|deny (defensive re-check of the DB CHECK constraint)', () => {
    const result = mapPolicyRow(rowOf({ effect: 'audit' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("must be 'allow' or 'deny'");
  });

  it("bans wildcard-action ALLOW rows (decide() vs evaluateAbac() '*' divergence, §3 Q8)", () => {
    const result = mapPolicyRow(rowOf({ permission: '*', effect: 'allow', rule: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain('wildcard-action allow policies are banned');
  });

  it('accepts wildcard-action DENY rows (consistent on both PDP paths)', () => {
    const result = mapPolicyRow(rowOf({ permission: '*', effect: 'deny' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule.action).toBe('*');
  });

  it('accepts value-less operators (owner, tenant_match) without a value', () => {
    const result = mapPolicyRow(
      rowOf({ rule: { conditions: [{ attribute: 'resource.ownerId', operator: 'owner' }] } }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('policy-row-mapper: malformed rule envelopes => MappingError (never coerced to [])', () => {
  const badRules: Array<[string, unknown, string]> = [
    ['non-object rule', 'garbage', 'rule must be a JSON object'],
    ['array rule', [{ attribute: 'resource.amount', operator: 'gt', value: 1 }], 'rule must be a JSON object'],
    ['null rule', null, 'rule must be a JSON object'],
    ['non-array conditions', { conditions: { attribute: 'resource.amount' } }, 'must be an array'],
    ['non-object condition', { conditions: ['resource.amount > 5'] }, 'must be an object'],
    ['unknown envelope key', { conditions: [], version: 2 }, 'unknown key'],
    ['unknown condition key', { conditions: [{ attribute: 'resource.amount', operator: 'gt', value: 1, note: 'x' }] }, 'unknown key'],
    ['unknown operator', { conditions: [{ attribute: 'resource.amount', operator: 'matches', value: 1 }] }, 'not a known operator'],
    ['missing value for a valued operator', { conditions: [{ attribute: 'resource.amount', operator: 'gt' }] }, 'value is required'],
    ['unrooted attribute path', { conditions: [{ attribute: 'amount', operator: 'gt', value: 1 }] }, 'attribute must be a dotted path'],
    ['empty path segment', { conditions: [{ attribute: 'resource..amount', operator: 'gt', value: 1 }] }, 'attribute must be a dotted path'],
    ['sub-path under the bare action root', { conditions: [{ attribute: 'action.name', operator: 'eq', value: 'x' }] }, 'attribute must be a dotted path'],
  ];

  it.each(badRules)('%s', (_name, rule, expectedReason) => {
    const result = mapPolicyRow(rowOf({ rule }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain(expectedReason);
  });

  it('rejects a `scope` key in the envelope (dead in the runtime — never ship write-accepted, never-read fields)', () => {
    const result = mapPolicyRow(rowOf({ rule: { scope: 'own_only', conditions: [] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain('rule.scope is banned');
  });
});

describe('policy-row-mapper: $attr references (validated-but-reserved, §3 Q3)', () => {
  const cond = (value: unknown) => ({ conditions: [{ attribute: 'resource.amount', operator: 'gt', value }] });

  it('accepts a string $attr path and keeps the marker RAW on the mapped rule', () => {
    const result = mapPolicyRow(rowOf({ rule: cond({ $attr: 'principal.approvalLimit' }) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule.conditions?.[0].value).toEqual({ $attr: 'principal.approvalLimit' });
  });

  it('accepts the {path, missing} object form', () => {
    const result = mapPolicyRow(
      rowOf({ rule: cond({ $attr: { path: 'principal.approvalLimit', missing: 'skip' } }) }),
    );
    expect(result.ok).toBe(true);
  });

  const badRefs: Array<[string, unknown, string]> = [
    ['unrooted path', { $attr: 'approvalLimit' }, 'must be a dotted path'],
    ['unknown root', { $attr: 'session.approvalLimit' }, 'must be a dotted path'],
    ['sibling keys next to $attr', { $attr: 'principal.approvalLimit', fallback: 0 }, 'must be the only key'],
    ['non-string/object reference', { $attr: 42 }, 'must be a string path or a {path, missing} object'],
    ['extra keys in the object form', { $attr: { path: 'principal.approvalLimit', default: 0 } }, 'allows only {path, missing}'],
    ['bad missing mode', { $attr: { path: 'principal.approvalLimit', missing: 'ignore' } }, "must be 'skip' or 'fail'"],
    ['object form without a valid path', { $attr: { missing: 'skip' } }, '"$attr".path must be a dotted path'],
  ];

  it.each(badRefs)('rejects %s', (_name, value, expectedReason) => {
    const result = mapPolicyRow(rowOf({ rule: cond(value) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain(expectedReason);
  });
});

describe('policy-row-mapper: empty-conditions semantics (§3 Q1)', () => {
  it('decodes the DB-default `{}` as unconditional (conditions: [])', () => {
    const result = mapPolicyRow(rowOf({ effect: 'allow', rule: {} }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule.conditions).toEqual([]);
    expect(result.warning).toBeUndefined();
  });

  it('decodes an explicit `{conditions: []}` identically', () => {
    const result = mapPolicyRow(rowOf({ effect: 'allow', rule: { conditions: [] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule.conditions).toEqual([]);
  });

  it('surfaces a warning (not an error) for an unconditional DENY row', () => {
    const result = mapPolicyRow(rowOf({ effect: 'deny', rule: {} }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toContain('unconditional deny');

    const batch = mapPolicyRows([rowOf({ effect: 'deny', rule: {} })]);
    expect(batch.errors).toEqual([]);
    expect(batch.rules).toHaveLength(1);
    expect(batch.warnings).toHaveLength(1);
    expect(batch.warnings[0].rowId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });
});

describe('policy-row-mapper: ALL-OR-NOTHING load semantics for BOTH effects (§3 Q8, §6)', () => {
  const validAllow = rowOf({ id: 'aaaaaaaa-0000-4000-8000-00000000000a', effect: 'allow' });
  const validDeny = rowOf({ id: 'aaaaaaaa-0000-4000-8000-00000000000b', effect: 'deny' });
  const brokenDeny = rowOf({ id: 'aaaaaaaa-0000-4000-8000-00000000000c', effect: 'deny', rule: 'garbage' });
  const brokenAllow = rowOf({ id: 'aaaaaaaa-0000-4000-8000-00000000000d', effect: 'allow', permission: 'not.a.permission' });

  it('a broken DENY must not vanish while allows load (rules come back EMPTY)', () => {
    const result = mapPolicyRows([validAllow, brokenDeny]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].rowId).toBe(brokenDeny.id);
    // The valid allow must NOT survive: a partial set would enforce with the deny silently gone.
    expect(result.rules).toEqual([]);
  });

  it('a broken ALLOW must fail the load too (a dropped allow empties the PDP allow-gate => fail-open)', () => {
    const result = mapPolicyRows([validDeny, brokenAllow]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].rowId).toBe(brokenAllow.id);
    expect(result.rules).toEqual([]);
  });

  it('collects EVERY error (not just the first) so one remediation pass fixes the load', () => {
    const result = mapPolicyRows([brokenDeny, brokenAllow, validAllow]);
    expect(result.errors.map((e) => e.rowId).sort()).toEqual([brokenAllow.id, brokenDeny.id].sort());
    expect(result.rules).toEqual([]);
  });

  it('an all-valid set loads fully', () => {
    const result = mapPolicyRows([validAllow, validDeny]);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(2);
  });
});

describe('policy-row-mapper: is_active filtering (the one legitimate row drop)', () => {
  it('drops inactive rows before mapping', () => {
    const result = mapPolicyRows([rowOf(), rowOf({ id: 'aaaaaaaa-0000-4000-8000-000000000002', is_active: false })]);
    expect(result.errors).toEqual([]);
    expect(result.rules.map((r) => r.id)).toEqual(['aaaaaaaa-0000-4000-8000-000000000001']);
  });

  it('an inactive MALFORMED row does not fail the load (deactivation is the remediation path)', () => {
    const result = mapPolicyRows([
      rowOf(),
      rowOf({ id: 'aaaaaaaa-0000-4000-8000-000000000003', is_active: false, rule: 'garbage' }),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
  });
});

describe('policy-row-mapper: deterministic priority ASC, id ASC ordering (§3 Q8 — determinism only)', () => {
  it('sorts by priority then id regardless of input order', () => {
    const rows = [
      rowOf({ id: 'cccccccc-0000-4000-8000-000000000001', priority: 200 }),
      rowOf({ id: 'bbbbbbbb-0000-4000-8000-000000000001', priority: 100 }),
      rowOf({ id: 'aaaaaaaa-0000-4000-8000-000000000001', priority: 100 }),
    ];
    const result = mapPolicyRows(rows);
    expect(result.rules.map((r) => r.id)).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000001',
      'cccccccc-0000-4000-8000-000000000001',
    ]);
  });
});

describe('parseRuleEnvelope / policyActionOf / validatePolicyWrite (shared with the PAP write path, §3 Q2)', () => {
  it('policyActionOf: known Permission and "*" pass; anything else is undefined', () => {
    expect(policyActionOf(Permission.ExpenseReportApprove)).toBe(Permission.ExpenseReportApprove);
    expect(policyActionOf('*')).toBe('*');
    expect(policyActionOf('nope')).toBeUndefined();
    expect(policyActionOf('')).toBeUndefined();
  });

  it('parseRuleEnvelope: undefined conditions decode to []', () => {
    const parsed = parseRuleEnvelope({});
    expect(parsed).toEqual({ ok: true, conditions: [] });
  });

  it('validatePolicyWrite: a valid write has zero violations (rule defaults to {})', () => {
    expect(validatePolicyWrite({ permission: Permission.ExpenseReportApprove, effect: 'deny' })).toEqual([]);
  });

  it('validatePolicyWrite: reports EVERY violation of a bad write at once', () => {
    const violations = validatePolicyWrite({
      permission: 'not.a.permission',
      effect: 'audit',
      rule: { scope: 'own_only' },
    });
    expect(violations).toHaveLength(3);
    expect(violations.join('\n')).toContain('not a known Permission');
    expect(violations.join('\n')).toContain("must be 'allow' or 'deny'");
    expect(violations.join('\n')).toContain('rule.scope is banned');
  });

  it('validatePolicyWrite: bans wildcard-action allow, accepts wildcard deny', () => {
    expect(validatePolicyWrite({ permission: '*', effect: 'allow' }).join('\n')).toContain(
      'wildcard-action allow policies are banned',
    );
    expect(validatePolicyWrite({ permission: '*', effect: 'deny' })).toEqual([]);
  });
});
