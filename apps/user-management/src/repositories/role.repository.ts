import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for the role aggregate (`roles` + the `role_permissions` join). Every method takes the
 * ambient RLS-scoped `Transaction` opened by the service via `withTenantTransaction`.
 */
@provideSingleton(RoleRepository)
export class RoleRepository {
  async list(t: Transaction): Promise<UserManagementShape.RoleRow[]> {
    const { Role } = getIdentityContext();
    const rows = await Role.findAll({ transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.RoleRow);
  }

  async findById(id: string, t: Transaction): Promise<UserManagementShape.RoleRow | null> {
    const { Role } = getIdentityContext();
    const row = await Role.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as UserManagementShape.RoleRow) : null;
  }

  async create(data: UserManagementShape.CreateRoleInput, t: Transaction): Promise<UserManagementShape.RoleRow> {
    const { Role } = getIdentityContext();
    const row = await Role.create({ ...data, is_system: false }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.RoleRow;
  }

  /** Replace a role's permission set with exactly the given permission ids. */
  async setPermissions(roleId: string, permissionIds: string[], t: Transaction): Promise<void> {
    const { RolePermission } = getIdentityContext();
    await RolePermission.destroy({ where: { role_id: roleId }, transaction: t });
    if (permissionIds.length) {
      await RolePermission.bulkCreate(
        permissionIds.map((permission_id) => ({ role_id: roleId, permission_id })),
        { transaction: t },
      );
    }
  }
}
