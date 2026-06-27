import { createInMemoryEnforcer, enforce, CASBIN_MODEL } from '../src/enforcer';
import { Permission, SystemRole } from '@aegis/shared-enums';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

describe('Casbin enforcer (RBAC with tenant domains)', () => {
  it('model declares sub,dom,act with a tenant-domain matcher', () => {
    expect(CASBIN_MODEL).toContain('r = sub, dom, act');
    expect(CASBIN_MODEL).toContain('r.sub == p.sub');
    expect(CASBIN_MODEL).toContain('g(r.sub, p.sub, r.dom)');
    expect(CASBIN_MODEL).toContain('p.dom == r.dom');
  });

  it('allows a role that holds the permission in its tenant domain', async () => {
    const e = await createInMemoryEnforcer({
      policies: [{ sub: SystemRole.Approver, dom: TENANT_A, act: Permission.ExpenseReportApprove }],
    });
    expect(await enforce(e, SystemRole.Approver, TENANT_A, Permission.ExpenseReportApprove)).toBe(true);
  });

  it('denies a permission the role does not hold (fail-closed default)', async () => {
    const e = await createInMemoryEnforcer({
      policies: [{ sub: SystemRole.Approver, dom: TENANT_A, act: Permission.ExpenseReportView }],
    });
    expect(await enforce(e, SystemRole.Approver, TENANT_A, Permission.ExpenseReportApprove)).toBe(false);
  });

  it('isolates by tenant domain — a grant in tenant A does not apply in tenant B', async () => {
    const e = await createInMemoryEnforcer({
      policies: [{ sub: SystemRole.Approver, dom: TENANT_A, act: Permission.ExpenseReportApprove }],
    });
    expect(await enforce(e, SystemRole.Approver, TENANT_A, Permission.ExpenseReportApprove)).toBe(true);
    expect(await enforce(e, SystemRole.Approver, TENANT_B, Permission.ExpenseReportApprove)).toBe(false);
  });

  it('honors a wildcard-domain policy for system roles across every tenant', async () => {
    const e = await createInMemoryEnforcer({
      policies: [{ sub: SystemRole.Owner, dom: '*', act: Permission.TenantManage }],
    });
    expect(await enforce(e, SystemRole.Owner, TENANT_A, Permission.TenantManage)).toBe(true);
    expect(await enforce(e, SystemRole.Owner, TENANT_B, Permission.TenantManage)).toBe(true);
  });

  it('resolves a user→role grouping in a tenant domain (role→permission via g)', async () => {
    const e = await createInMemoryEnforcer({
      policies: [{ sub: SystemRole.Approver, dom: TENANT_A, act: Permission.InvoiceApprove }],
      groupings: [{ user: 'user-1', role: SystemRole.Approver, dom: TENANT_A }],
    });
    // The user inherits the role's permission in the same domain...
    expect(await enforce(e, 'user-1', TENANT_A, Permission.InvoiceApprove)).toBe(true);
    // ...but not in another tenant domain.
    expect(await enforce(e, 'user-1', TENANT_B, Permission.InvoiceApprove)).toBe(false);
    // ...and not a permission the role lacks.
    expect(await enforce(e, 'user-1', TENANT_A, Permission.PayRunApprove)).toBe(false);
  });

  it('supports a direct user grant (sub = userId)', async () => {
    const e = await createInMemoryEnforcer({
      policies: [{ sub: 'user-direct', dom: TENANT_A, act: Permission.AuditView }],
    });
    expect(await enforce(e, 'user-direct', TENANT_A, Permission.AuditView)).toBe(true);
  });

  it('enforce() fails closed on an unknown subject', async () => {
    const e = await createInMemoryEnforcer({
      policies: [{ sub: SystemRole.Owner, dom: TENANT_A, act: Permission.TenantManage }],
    });
    expect(await enforce(e, 'nobody', TENANT_A, Permission.TenantManage)).toBe(false);
  });
});
