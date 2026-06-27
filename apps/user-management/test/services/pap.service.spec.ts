import 'reflect-metadata';
import type { Transaction } from 'sequelize';
import { Scope } from '@aegis/shared-enums';
import { runInContext, TEST_TENANT } from '@aegis/testing';

// withTenantTransaction just runs the callback with a fake transaction (no real DB in unit tests).
jest.mock('@aegis/db', () => ({
  withTenantTransaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> => fn({} as Transaction),
}));

// AuditLogger.record is a no-op here (its own behaviour is covered by libs/audit specs).
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn().mockResolvedValue(undefined) } }));

// Capture the Casbin policy projection the PAP fans out after each write (W5-03).
const applyPolicyGrant = jest.fn().mockResolvedValue(undefined);
jest.mock('@aegis/access-control', () => ({
  applyPolicyGrant: (...a: unknown[]) => applyPolicyGrant(...a),
}));

import { PapService } from '../../src/services/pap.service';
import type { RoleRepository } from '../../src/repositories/role.repository';
import type { PermissionRepository } from '../../src/repositories/permission.repository';
import type { UserRoleRepository } from '../../src/repositories/user-role.repository';

function makeService(over: {
  roles?: Partial<RoleRepository>;
  permissions?: Partial<PermissionRepository>;
  userRoles?: Partial<UserRoleRepository>;
} = {}) {
  const roles = {
    create: jest.fn().mockResolvedValue({ id: 'role-1', name: 'auditor' }),
    setPermissions: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue({ id: 'role-1', name: 'auditor' }),
    ...over.roles,
  } as unknown as RoleRepository;
  const permissions = {
    findByNames: jest.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]),
    ...over.permissions,
  } as unknown as PermissionRepository;
  const userRoles = {
    // Default: first assignment (no prior role) -> assign returns null.
    assign: jest.fn().mockResolvedValue(null),
    ...over.userRoles,
  } as unknown as UserRoleRepository;
  return new PapService(roles, permissions, userRoles);
}

describe('PapService — Casbin projection after PAP writes (W5-03)', () => {
  beforeEach(() => applyPolicyGrant.mockClear());

  it('createRole projects role→permission p-rules (dom = tenant) after the write', async () => {
    const svc = makeService();
    await runInContext(() =>
      svc.createRole({ name: 'auditor', permissions: ['audit.view', 'expense.report.view'] }),
    );

    expect(applyPolicyGrant).toHaveBeenCalledTimes(1);
    const grant = applyPolicyGrant.mock.calls[0][0] as {
      permissions: Array<{ sub: string; dom: string; act: string }>;
    };
    expect(grant.permissions).toEqual([
      { sub: 'auditor', dom: TEST_TENANT, act: 'audit.view' },
      { sub: 'auditor', dom: TEST_TENANT, act: 'expense.report.view' },
    ]);
  });

  it('assignRole projects a user→role g-rule (dom = tenant) after the write', async () => {
    const svc = makeService();
    await runInContext(() => svc.assignRole({ userId: 'u-7', roleId: 'role-1', scope: Scope.AllRecords }));

    expect(applyPolicyGrant).toHaveBeenCalledTimes(1);
    const grant = applyPolicyGrant.mock.calls[0][0] as {
      groupings: Array<{ user: string; role: string; dom: string }>;
    };
    expect(grant.groupings).toEqual([{ user: 'u-7', role: 'auditor', dom: TEST_TENANT }]);
  });

  it('does NOT project when the relational write fails (createRole validation)', async () => {
    const svc = makeService({
      permissions: { findByNames: jest.fn().mockResolvedValue([]) } as unknown as PermissionRepository,
    });
    await expect(
      runInContext(() => svc.createRole({ name: 'x', permissions: ['unknown.perm'] })),
    ).rejects.toBeDefined();
    expect(applyPolicyGrant).not.toHaveBeenCalled();
  });

  it('a projection failure does NOT fail the request (catalog is source of truth, fail-closed at gate)', async () => {
    applyPolicyGrant.mockRejectedValueOnce(new Error('redis down'));
    const svc = makeService();
    await expect(
      runInContext(() => svc.assignRole({ userId: 'u-7', roleId: 'role-1' })),
    ).resolves.toEqual({ assigned: true });
  });

  // BUG-0008: re-assigning a user from an OLD role to a new one must revoke the stale grouping.
  it('re-assignment revokes the PRIOR role grouping AND adds the new one in the same projection', async () => {
    const svc = makeService({
      // assign reports the prior role_id (the user already held role-old).
      userRoles: { assign: jest.fn().mockResolvedValue('role-old') } as unknown as UserRoleRepository,
      // findById: target role-1 -> 'auditor'; prior role-old -> 'viewer'.
      roles: {
        findById: jest.fn(async (id: string) =>
          id === 'role-old' ? { id: 'role-old', name: 'viewer' } : { id: 'role-1', name: 'auditor' },
        ),
      } as unknown as RoleRepository,
    });

    await runInContext(() => svc.assignRole({ userId: 'u-7', roleId: 'role-1' }));

    expect(applyPolicyGrant).toHaveBeenCalledTimes(1);
    const grant = applyPolicyGrant.mock.calls[0][0] as {
      groupings: Array<{ user: string; role: string; dom: string }>;
      revokeGroupings: Array<{ user: string; role: string; dom: string }>;
    };
    expect(grant.groupings).toEqual([{ user: 'u-7', role: 'auditor', dom: TEST_TENANT }]);
    expect(grant.revokeGroupings).toEqual([{ user: 'u-7', role: 'viewer', dom: TEST_TENANT }]);
  });

  it('does NOT revoke when re-assigning the SAME role (only the new grouping is projected)', async () => {
    const svc = makeService({
      userRoles: { assign: jest.fn().mockResolvedValue('role-1') } as unknown as UserRoleRepository,
    });

    await runInContext(() => svc.assignRole({ userId: 'u-7', roleId: 'role-1' }));

    const grant = applyPolicyGrant.mock.calls[0][0] as {
      groupings: unknown[];
      revokeGroupings?: unknown[];
    };
    expect(grant.revokeGroupings).toBeUndefined();
  });

  // BUG-0008 fail-closed: a re-assignment's revoke is security-critical — a projection failure must
  // SURFACE (not be swallowed like an add-only projection), so the stale grant is never silently kept.
  it('a re-assignment projection failure FAILS the request (fail-closed on revoke)', async () => {
    applyPolicyGrant.mockRejectedValueOnce(new Error('redis down'));
    const svc = makeService({
      userRoles: { assign: jest.fn().mockResolvedValue('role-old') } as unknown as UserRoleRepository,
      roles: {
        findById: jest.fn(async (id: string) =>
          id === 'role-old' ? { id: 'role-old', name: 'viewer' } : { id: 'role-1', name: 'auditor' },
        ),
      } as unknown as RoleRepository,
    });

    await expect(
      runInContext(() => svc.assignRole({ userId: 'u-7', roleId: 'role-1' })),
    ).rejects.toThrow('redis down');
  });
});
