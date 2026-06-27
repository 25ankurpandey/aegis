import type { Request, Response } from 'express';
import {
  authorize,
  authorizeAny,
  setEnforcer,
  resetEnforcer,
  applyPolicyGrant,
  reloadEnforcer,
} from '../src/pep';
import { createInMemoryEnforcer, enforce } from '../src/enforcer';
import { amountCapPolicies } from '../src/policy-loader';
import { resetPolicyWatcherForTests } from '../src/watcher';
import { Permission, SystemRole, Scope } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function mockReqRes(principal?: AccessShape.Principal) {
  const req = { principal } as unknown as Request;
  const res = { locals: {} } as unknown as Response;
  return { req, res };
}

/** Drives the async authorize() middleware and resolves with the value passed to next(). */
function runGuard(
  handler: ReturnType<typeof authorize> | ReturnType<typeof authorizeAny>,
  req: Request,
  res: Response,
): Promise<unknown> {
  return new Promise((resolve) => {
    handler(req, res, (err?: unknown) => resolve(err));
  });
}

const approverInA = (over: Partial<AccessShape.Principal> = {}): AccessShape.Principal => ({
  userId: 'u1',
  tenantId: TENANT_A,
  roles: [SystemRole.Approver],
  ...over,
});

describe('PEP authorize() — Casbin RBAC gate', () => {
  beforeEach(async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [
        { sub: SystemRole.Approver, dom: TENANT_A, act: Permission.ExpenseReportApprove },
        { sub: SystemRole.Owner, dom: '*', act: Permission.TenantManage },
      ],
    });
    setEnforcer(enforcer);
  });
  afterEach(() => resetEnforcer());

  it('allows when the principal role holds the permission in its tenant', async () => {
    const { req, res } = mockReqRes(approverInA());
    const err = await runGuard(authorize(Permission.ExpenseReportApprove), req, res);
    expect(err).toBeUndefined();
  });

  it('denies (403) when the role lacks the permission', async () => {
    const { req, res } = mockReqRes(approverInA());
    const err = await runGuard(authorize(Permission.PayRunApprove), req, res) as { status?: number };
    expect(err?.status).toBe(403);
  });

  it('denies cross-tenant: an approver in tenant B has no grant', async () => {
    const { req, res } = mockReqRes(approverInA({ tenantId: TENANT_B }));
    const err = await runGuard(authorize(Permission.ExpenseReportApprove), req, res) as { status?: number };
    expect(err?.status).toBe(403);
  });

  it('honors a wildcard-domain system-role policy across tenants', async () => {
    const ownerB: AccessShape.Principal = { userId: 'o1', tenantId: TENANT_B, roles: [SystemRole.Owner] };
    const { req, res } = mockReqRes(ownerB);
    const err = await runGuard(authorize(Permission.TenantManage), req, res);
    expect(err).toBeUndefined();
  });

  it('allows any granted permission and records which one matched', async () => {
    const { req, res } = mockReqRes(approverInA());
    const err = await runGuard(
      authorizeAny([Permission.PayRunApprove, Permission.ExpenseReportApprove]),
      req,
      res,
    );
    expect(err).toBeUndefined();
    expect(res.locals.authorizedPermission).toBe(Permission.ExpenseReportApprove);
  });

  it('fails closed when not authenticated', async () => {
    const { req, res } = mockReqRes(undefined);
    const err = await runGuard(authorize(Permission.ExpenseReportApprove), req, res) as { status?: number };
    expect(err?.status).toBe(401);
  });

  it('applies row-level scope as a second gate after Casbin allows', async () => {
    const principal = approverInA({ scope: Scope.OwnOnly });
    const { req, res } = mockReqRes(principal);
    const guard = authorize(Permission.ExpenseReportApprove, {
      resource: () => ({ type: 'expense_report', tenantId: TENANT_A, ownerId: 'someone-else' }),
    });
    const err = await runGuard(guard, req, res) as { status?: number };
    expect(err?.status).toBe(403);
  });
});

describe('PEP authorize() — ABAC amount-cap (W5-04)', () => {
  beforeEach(async () => {
    setEnforcer(
      await createInMemoryEnforcer({
        policies: [{ sub: SystemRole.Approver, dom: TENANT_A, act: Permission.ExpenseReportApprove }],
      }),
    );
  });
  afterEach(() => resetEnforcer());

  const approveGuard = () =>
    authorize(Permission.ExpenseReportApprove, {
      resource: (req) => (req as unknown as { _resource: AccessShape.ResourceRef })._resource,
      policies: amountCapPolicies(Permission.ExpenseReportApprove),
    });

  function reqWithAmount(amount: number, attributes?: Record<string, unknown>) {
    const principal = approverInA({ attributes });
    const req = { principal } as unknown as Request & { _resource: AccessShape.ResourceRef };
    req._resource = { type: 'expense_report', tenantId: TENANT_A, attributes: { amount } };
    const res = { locals: {} } as unknown as Response;
    return { req, res };
  }

  it('DENIES an over-cap approval even though Casbin RBAC granted approve', async () => {
    const { req, res } = reqWithAmount(150_00, { approvalLimit: 100_00 });
    const err = (await runGuard(approveGuard(), req, res)) as { status?: number };
    expect(err?.status).toBe(403);
  });

  it('ALLOWS an at-or-under-cap approval', async () => {
    const { req, res } = reqWithAmount(100_00, { approvalLimit: 100_00 });
    const err = await runGuard(approveGuard(), req, res);
    expect(err).toBeUndefined();
  });

  it('ALLOWS when the approver carries no approvalLimit (RBAC alone decides, back-compat)', async () => {
    const { req, res } = reqWithAmount(999_99);
    const err = await runGuard(approveGuard(), req, res);
    expect(err).toBeUndefined();
  });
});

describe('PAP policy projection + reload (W5-03)', () => {
  afterEach(() => {
    resetEnforcer();
    resetPolicyWatcherForTests();
  });

  it('after a grant, enforce reflects it WITHOUT a fresh process', async () => {
    const enforcer = await createInMemoryEnforcer();
    setEnforcer(enforcer);
    // Before: the role holds no permission in the tenant.
    expect(await enforce(enforcer, SystemRole.Approver, TENANT_A, Permission.ExpenseReportApprove)).toBe(false);

    // PAP-equivalent runtime write: project a role→permission grant + a user→role grouping.
    await applyPolicyGrant({
      permissions: [{ sub: SystemRole.Approver, dom: TENANT_A, act: Permission.ExpenseReportApprove }],
      groupings: [{ user: 'u-new', role: SystemRole.Approver, dom: TENANT_A }],
    });

    // After: the same long-lived enforcer now grants it — no restart, no re-seed.
    expect(await enforce(enforcer, SystemRole.Approver, TENANT_A, Permission.ExpenseReportApprove)).toBe(true);
    expect(await enforce(enforcer, 'u-new', TENANT_A, Permission.ExpenseReportApprove)).toBe(true);
  });

  it('the authorize() gate reflects a freshly-projected grant on the running enforcer', async () => {
    const enforcer = await createInMemoryEnforcer();
    setEnforcer(enforcer);
    const principal: AccessShape.Principal = { userId: 'u9', tenantId: TENANT_A, roles: ['custom-role'] };

    // Denied before the grant exists.
    const r1 = mockReqRes(principal);
    const before = (await runGuard(authorize(Permission.ExpenseReportApprove), r1.req, r1.res)) as {
      status?: number;
    };
    expect(before?.status).toBe(403);

    await applyPolicyGrant({
      permissions: [{ sub: 'custom-role', dom: TENANT_A, act: Permission.ExpenseReportApprove }],
    });

    // Allowed after — same process, same enforcer singleton.
    const r2 = mockReqRes(principal);
    const after = await runGuard(authorize(Permission.ExpenseReportApprove), r2.req, r2.res);
    expect(after).toBeUndefined();
  });

  it('reloadEnforcer fails CLOSED: a loadPolicy error clears policy so the pod denies', async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [{ sub: SystemRole.Approver, dom: TENANT_A, act: Permission.ExpenseReportApprove }],
    });
    setEnforcer(enforcer);
    expect(await enforce(enforcer, SystemRole.Approver, TENANT_A, Permission.ExpenseReportApprove)).toBe(true);

    // Simulate a store/adapter failure on reload.
    jest.spyOn(enforcer, 'loadPolicy').mockRejectedValueOnce(new Error('store unreachable'));
    await expect(reloadEnforcer()).rejects.toThrow('store unreachable');

    // Fail-closed: policy was cleared, so the previously-allowed grant now denies.
    expect(await enforce(enforcer, SystemRole.Approver, TENANT_A, Permission.ExpenseReportApprove)).toBe(false);
  });

  it('reloadEnforcer is a no-op when no enforcer has been built', async () => {
    resetEnforcer();
    await expect(reloadEnforcer()).resolves.toBeUndefined();
  });

  // BUG-0008: re-assigning a user from roleA to roleB must REVOKE the stale roleA grouping, so the
  // user immediately loses roleA's permissions on the running enforcer (no restart, no re-seed).
  it('revokeGroupings removes a stale user→role grouping so the old role permission is DENIED', async () => {
    const roleA = 'role-a';
    const roleB = 'role-b';
    const permA = Permission.ExpenseReportApprove;
    const permB = Permission.PayRunApprove;
    const enforcer = await createInMemoryEnforcer({
      policies: [
        { sub: roleA, dom: TENANT_A, act: permA },
        { sub: roleB, dom: TENANT_A, act: permB },
      ],
      groupings: [{ user: 'u-reassign', role: roleA, dom: TENANT_A }],
    });
    setEnforcer(enforcer);
    // Before re-assignment: user holds roleA, so permA is allowed and permB denied.
    expect(await enforce(enforcer, 'u-reassign', TENANT_A, permA)).toBe(true);
    expect(await enforce(enforcer, 'u-reassign', TENANT_A, permB)).toBe(false);

    // PAP re-assignment projection: revoke the prior grouping, add the new one — in one call.
    await applyPolicyGrant({
      groupings: [{ user: 'u-reassign', role: roleB, dom: TENANT_A }],
      revokeGroupings: [{ user: 'u-reassign', role: roleA, dom: TENANT_A }],
    });

    // After: the old role's permission is DENIED and the new role's permission is ALLOWED — without
    // a process restart. This is the privilege-retention bug fixed.
    expect(await enforce(enforcer, 'u-reassign', TENANT_A, permA)).toBe(false);
    expect(await enforce(enforcer, 'u-reassign', TENANT_A, permB)).toBe(true);
  });
});
