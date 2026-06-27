import { inject } from 'inversify';
import { ErrUtils, Logger, RequestContext } from '@aegis/service-core';
import { AuditAction, AuditOutcome, Scope } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
import { withTenantTransaction } from '@aegis/db';
import { AuditLogger } from '@aegis/audit';
import { applyPolicyGrant } from '@aegis/access-control';
import { provideSingleton } from '../ioc/container';
import { RoleRepository } from '../repositories/role.repository';
import { PermissionRepository } from '../repositories/permission.repository';
import { UserRoleRepository } from '../repositories/user-role.repository';

/**
 * Policy Administration Point. Roles, permissions, and assignments are managed at RUNTIME —
 * no migration/deploy needed (the fix over a migration-only model). See docs/03-access-control-model.md.
 * The service owns the transaction (`withTenantTransaction`); repositories take it.
 */
@provideSingleton(PapService)
export class PapService {
  constructor(
    @inject(RoleRepository) private readonly roles: RoleRepository,
    @inject(PermissionRepository) private readonly permissions: PermissionRepository,
    @inject(UserRoleRepository) private readonly userRoles: UserRoleRepository,
  ) {}

  async listRoles(): Promise<UserManagementShape.RoleRow[]> {
    return withTenantTransaction((t) => this.roles.list(t));
  }

  async listPermissions(): Promise<UserManagementShape.PermissionRow[]> {
    return withTenantTransaction((t) => this.permissions.list(t));
  }

  /** Create a tenant-scoped custom role with a chosen permission set — takes effect immediately. */
  async createRole(input: UserManagementShape.CreateRolePapInput): Promise<UserManagementShape.RoleRow> {
    const tenantId = RequestContext.tenantId();
    const role = await withTenantTransaction(async (t) => {
      const perms = await this.permissions.findByNames(input.permissions, t);
      if (perms.length !== new Set(input.permissions).size) {
        throw ErrUtils.validation('Unknown permission(s) in request');
      }
      const created = await this.roles.create(
        { tenant_id: tenantId, name: input.name, description: input.description },
        t,
      );
      await this.roles.setPermissions(created.id, perms.map((p) => p.id), t);
      await AuditLogger.record(
        {
          action: AuditAction.RoleCreated,
          outcome: AuditOutcome.Success,
          resourceType: 'role',
          resourceId: created.id,
          details: { name: input.name, permissions: input.permissions },
        },
        t,
      );
      return created;
    });

    // AFTER commit: project the new role→permission grants into the Casbin policy store and fan out a
    // reload so the running pods enforce them WITHOUT a restart (W5-03). The custom role's domain is
    // the tenant (dom = tenantId); the subject is the role NAME the PEP carries on the principal.
    await this.projectGrant(
      {
        permissions: input.permissions.map((act) => ({ sub: input.name, dom: tenantId, act })),
      },
      'role',
      role.id,
    );
    return role;
  }

  /** Assign (or re-assign) a user's role + row-level scope — takes effect on their next token. */
  async assignRole(input: UserManagementShape.AssignRolePapInput): Promise<UserManagementShape.AssignRoleResult> {
    const tenantId = RequestContext.tenantId();
    const { role, priorRole } = await withTenantTransaction(async (t) => {
      const found = await this.roles.findById(input.roleId, t);
      if (!found) throw ErrUtils.notFound('Role not found');
      const priorRoleId = await this.userRoles.assign(
        { tenant_id: tenantId, user_id: input.userId, role_id: input.roleId, scope: input.scope ?? Scope.OwnOnly },
        t,
      );
      // Resolve the prior role NAME (Casbin groupings are keyed on role name, not id) so we can revoke
      // the stale membership after commit. Skip when there was no prior role or it is unchanged.
      const prior =
        priorRoleId && priorRoleId !== input.roleId ? await this.roles.findById(priorRoleId, t) : null;
      await AuditLogger.record(
        {
          action: AuditAction.RoleAssigned,
          outcome: AuditOutcome.Success,
          resourceType: 'user',
          resourceId: input.userId,
          details: { roleId: input.roleId, scope: input.scope ?? Scope.OwnOnly, priorRoleId: priorRoleId ?? undefined },
        },
        t,
      );
      return { role: found, priorRole: prior };
    });

    // AFTER commit: project the user→role grouping (g-rule) into the Casbin store + fan out a reload
    // so the membership is enforced on the running pods immediately (W5-03). Casbin matches the role
    // NAME (which the PEP carries on principal.roles), domain = the membership's tenant.
    //
    // BUG-0008: on a RE-ASSIGNMENT also REVOKE the prior role's grouping in the SAME projection, so the
    // user stops inheriting the old role's permissions on every pod without a restart. The revoke is
    // applied before the add (fail-closed ordering inside applyPolicyGrant). A re-assignment's revoke
    // is security-critical, so it is NOT best-effort: a revoke failure must surface (see projectGrant).
    const isReassignment = priorRole !== null && priorRole.name !== role.name;
    await this.projectGrant(
      {
        groupings: [{ user: input.userId, role: role.name, dom: tenantId }],
        revokeGroupings: priorRole ? [{ user: input.userId, role: priorRole.name, dom: tenantId }] : undefined,
      },
      'user',
      input.userId,
      { failOnError: isReassignment },
    );
    return { assigned: true };
  }

  /**
   * Push a committed PAP write into the live Casbin policy store and fan out a cross-pod reload
   * (W5-03), so dynamic roles/grants take effect without a restart. Best-effort + non-fatal by
   * default: the relational catalog is the source of truth and the write already committed, so an
   * ADD-only projection failure must NOT fail the request — it is logged at alert severity for ops to
   * reconcile (a re-seed / next mutation re-converges the store). Fail-closed is preserved at the
   * GATE: a pod that never learns of a new grant simply keeps denying it, the safe direction.
   *
   * `opts.failOnError` (BUG-0008): when the projection includes a security-critical REVOCATION (the
   * stale grouping on a re-assignment), a failure is NOT safe to swallow — leaving the old grouping in
   * the store keeps granting the prior role's permissions on every pod. In that case we still alert,
   * then RETHROW so the caller can react (surface the failure rather than silently retaining access).
   */
  private async projectGrant(
    grant: Parameters<typeof applyPolicyGrant>[0],
    resourceType: string,
    resourceId: string,
    opts: { failOnError?: boolean } = {},
  ): Promise<void> {
    try {
      await applyPolicyGrant(grant);
    } catch (err) {
      Logger.alert('PAP policy projection failed — Casbin store may lag the catalog until re-seed', {
        errType: 'POLICY_PROJECTION_FAILED',
        resourceType,
        resourceId,
        error: (err as Error).message,
        revocation: opts.failOnError ?? false,
      });
      if (opts.failOnError) throw err;
    }
  }
}
