import { amountCapPolicies, combinePolicies, APPROVAL_LIMIT_ATTR } from '../src/policy-loader';
import { evaluateAbac } from '../src/pdp';
import { Permission, Scope } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';

const principal = (over: Partial<AccessShape.Principal> = {}): AccessShape.Principal => ({
  userId: 'u1',
  tenantId: 't1',
  roles: ['approver'],
  // all-records scope: these tests exercise the amount-cap ABAC path, not row scope (which now
  // fail-closes a missing scope to own-only — SCOPE-05).
  scope: Scope.AllRecords,
  ...over,
});

const reportOf = (amount: number): AccessShape.ResourceRef => ({
  type: 'expense_report',
  tenantId: 't1',
  attributes: { amount },
});

describe('amountCapPolicies (W5-04)', () => {
  const loader = amountCapPolicies(Permission.ExpenseReportApprove);

  it('emits no policy when the principal has no approval limit', async () => {
    expect(await loader(principal())).toEqual([]);
  });

  it('emits a deny-override that fires above the cap', async () => {
    const p = principal({ attributes: { [APPROVAL_LIMIT_ATTR]: 100_00 } });
    const rules = await loader(p);
    expect(rules).toHaveLength(1);
    expect(rules[0].effect).toBe('deny');

    // Over-cap → denied by the loaded policy through the PDP.
    const over = evaluateAbac(
      { principal: p, action: Permission.ExpenseReportApprove, resource: reportOf(150_00) },
      rules,
    );
    expect(over.allow).toBe(false);

    // At/under cap → allowed.
    const under = evaluateAbac(
      { principal: p, action: Permission.ExpenseReportApprove, resource: reportOf(100_00) },
      rules,
    );
    expect(under.allow).toBe(true);
  });

  it('tolerates a string-encoded approvalLimit (JWT claims are often strings)', async () => {
    const p = principal({ attributes: { [APPROVAL_LIMIT_ATTR]: '100' } });
    const rules = await loader(p);
    expect(evaluateAbac({ principal: p, action: Permission.ExpenseReportApprove, resource: reportOf(101) }, rules).allow).toBe(false);
  });

  it('never trips when the resource carries no amount', async () => {
    const p = principal({ attributes: { [APPROVAL_LIMIT_ATTR]: 100_00 } });
    const rules = await loader(p);
    const d = evaluateAbac(
      { principal: p, action: Permission.ExpenseReportApprove, resource: { type: 'expense_report', tenantId: 't1' } },
      rules,
    );
    expect(d.allow).toBe(true);
  });
});

describe('amountCapPolicies — ABAC-01 close (cap now has a source via the PIP)', () => {
  const loader = amountCapPolicies(Permission.ExpenseReportApprove);
  const decide = (p: AccessShape.Principal, rules: AccessShape.PolicyRule[], amount: number) =>
    evaluateAbac(
      { principal: p, action: Permission.ExpenseReportApprove, resource: reportOf(amount) },
      rules,
    );

  it('DENIES an over-cap approval', async () => {
    const p = principal({ attributes: { [APPROVAL_LIMIT_ATTR]: 5000_00 } });
    const rules = await loader(p);
    expect(decide(p, rules, 5000_01).allow).toBe(false);
  });

  it('ALLOWS an at-cap approval (boundary is inclusive — gt, not gte)', async () => {
    const p = principal({ attributes: { [APPROVAL_LIMIT_ATTR]: 5000_00 } });
    const rules = await loader(p);
    expect(decide(p, rules, 5000_00).allow).toBe(true);
  });

  it('ALLOWS an under-cap approval', async () => {
    const p = principal({ attributes: { [APPROVAL_LIMIT_ATTR]: 5000_00 } });
    const rules = await loader(p);
    expect(decide(p, rules, 1_00).allow).toBe(true);
  });

  it('is a NO-OP when the principal carries no approvalLimit (unlimited approver, back-compat)', async () => {
    const p = principal(); // no attributes at all
    const rules = await loader(p);
    expect(rules).toEqual([]);
    // With no cap rule, the amount-cap leg never denies — a huge amount still passes the ABAC leg.
    expect(decide(p, rules, 1_000_000_00).allow).toBe(true);
  });

  it('does not embed the cap in a client-facing message here — the leak fix lives in the PEP (ABAC-04)', async () => {
    // The policy id intentionally carries the cap for server-side logs; the PEP now returns a
    // generic client message instead of this reason (see pep.ts / ABAC-04).
    const p = principal({ attributes: { [APPROVAL_LIMIT_ATTR]: 5000_00 } });
    const rules = await loader(p);
    expect(rules[0].id).toContain('5000');
  });
});

describe('combinePolicies', () => {
  it('concatenates the rules from each loader', async () => {
    const a = amountCapPolicies(Permission.ExpenseReportApprove);
    const b = () => [
      { id: 'extra', effect: 'deny' as const, action: Permission.ExpenseReportApprove },
    ];
    const combined = combinePolicies(a, b);
    const rules = await combined(principal({ attributes: { [APPROVAL_LIMIT_ATTR]: 1 } }));
    expect(rules.map((r) => r.id)).toContain('extra');
    expect(rules.length).toBe(2);
  });
});
