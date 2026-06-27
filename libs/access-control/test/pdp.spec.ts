import { decide, evaluateAbac } from '../src/pdp';
import { Permission, Scope } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';

const principal = (over: Partial<AccessShape.Principal> = {}): AccessShape.Principal => ({
  userId: 'u1',
  tenantId: 't1',
  roles: ['approver'],
  permissions: [Permission.ExpenseReportApprove],
  ...over,
});

describe('PDP decide()', () => {
  it('denies when the permission is not granted', () => {
    const d = decide({ principal: principal({ permissions: [] }), action: Permission.ExpenseReportApprove });
    expect(d.allow).toBe(false);
  });

  it('allows when the permission is granted and there are no policies', () => {
    expect(decide({ principal: principal(), action: Permission.ExpenseReportApprove }).allow).toBe(true);
  });

  it('denies a cross-tenant resource', () => {
    const d = decide({
      principal: principal(),
      action: Permission.ExpenseReportApprove,
      resource: { type: 'expense_report', tenantId: 't2' },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/cross-tenant/);
  });

  it('enforces own-only scope', () => {
    const d = decide({
      principal: principal({ scope: Scope.OwnOnly }),
      action: Permission.ExpenseReportApprove,
      resource: { type: 'expense_report', ownerId: 'someone-else' },
    });
    expect(d.allow).toBe(false);
  });

  it('applies a deny-override policy', () => {
    const d = decide(
      {
        principal: principal(),
        action: Permission.ExpenseReportApprove,
        resource: { type: 'expense_report', attributes: { amount: 100000 } },
      },
      [
        {
          id: 'p1',
          effect: 'deny',
          action: Permission.ExpenseReportApprove,
          conditions: [{ attribute: 'resource.amount', operator: 'gt', value: 50000 }],
        },
      ],
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/policy p1/);
  });

  it('requires an allow-policy condition to match when allow-policies exist', () => {
    const policies: AccessShape.PolicyRule[] = [
      {
        id: 'a1',
        effect: 'allow',
        action: Permission.ExpenseReportApprove,
        conditions: [{ attribute: 'resource.amount', operator: 'lte', value: 50000 }],
      },
    ];
    expect(
      decide(
        { principal: principal(), action: Permission.ExpenseReportApprove, resource: { type: 'expense_report', attributes: { amount: 100000 } } },
        policies,
      ).allow,
    ).toBe(false);
    expect(
      decide(
        { principal: principal(), action: Permission.ExpenseReportApprove, resource: { type: 'expense_report', attributes: { amount: 100 } } },
        policies,
      ).allow,
    ).toBe(true);
  });
});

describe('PDP evaluateAbac() — Casbin-authoritative path (W5-04)', () => {
  // The principal carries NO permissions array (RBAC was already gated by Casbin upstream).
  const casbinOnly = (over: Partial<AccessShape.Principal> = {}): AccessShape.Principal => ({
    userId: 'u1',
    tenantId: 't1',
    roles: ['approver'],
    ...over,
  });

  it('allows by default when no policies/resource constraints apply', () => {
    expect(evaluateAbac({ principal: casbinOnly(), action: Permission.ExpenseReportApprove }).allow).toBe(true);
  });

  it('still denies a cross-tenant resource', () => {
    const d = evaluateAbac({
      principal: casbinOnly(),
      action: Permission.ExpenseReportApprove,
      resource: { type: 'expense_report', tenantId: 't2' },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/cross-tenant/);
  });

  it('applies a deny-override even though the principal carries no permissions array', () => {
    const d = evaluateAbac(
      {
        principal: casbinOnly(),
        action: Permission.ExpenseReportApprove,
        resource: { type: 'expense_report', attributes: { amount: 100000 } },
      },
      [
        {
          id: 'cap',
          effect: 'deny',
          action: Permission.ExpenseReportApprove,
          conditions: [{ attribute: 'resource.amount', operator: 'gt', value: 50000 }],
        },
      ],
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/policy cap/);
  });

  it('enforces own-only scope on the Casbin-only path', () => {
    const d = evaluateAbac({
      principal: casbinOnly({ scope: Scope.OwnOnly }),
      action: Permission.ExpenseReportApprove,
      resource: { type: 'expense_report', ownerId: 'someone-else' },
    });
    expect(d.allow).toBe(false);
  });
});
