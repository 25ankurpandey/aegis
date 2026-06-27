import { amountCapPolicies, combinePolicies, APPROVAL_LIMIT_ATTR } from '../src/policy-loader';
import { evaluateAbac } from '../src/pdp';
import { Permission } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';

const principal = (over: Partial<AccessShape.Principal> = {}): AccessShape.Principal => ({
  userId: 'u1',
  tenantId: 't1',
  roles: ['approver'],
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
