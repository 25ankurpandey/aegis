import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for the user-role aggregate (the `user_roles` assignment table). Every method takes the
 * ambient RLS-scoped `Transaction` opened by the service via `withTenantTransaction`.
 */
@provideSingleton(UserRoleRepository)
export class UserRoleRepository {
  /**
   * Assign (or re-assign) the single role a user holds in the current tenant. Returns the PRIOR
   * role_id the user held (or null if this is a first assignment) so the caller can revoke the stale
   * Casbin grouping on a re-assignment (BUG-0008) — without it, the user keeps the old role's
   * permissions forever.
   */
  async assign(input: UserManagementShape.AssignRoleRow, t: Transaction): Promise<string | null> {
    const { UserRole } = getIdentityContext();
    const existing = await UserRole.findOne({ where: { user_id: input.user_id }, transaction: t });
    if (existing) {
      const priorRoleId = (existing.get('role_id') as string | null) ?? null;
      await existing.update({ role_id: input.role_id, scope: input.scope }, { transaction: t });
      return priorRoleId;
    }
    await UserRole.create({ ...input }, { transaction: t });
    return null;
  }
}
