import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for the permission aggregate (the global `permissions` catalog). Every method takes the
 * ambient RLS-scoped `Transaction` opened by the service via `withTenantTransaction`.
 */
@provideSingleton(PermissionRepository)
export class PermissionRepository {
  async list(t: Transaction): Promise<UserManagementShape.PermissionRow[]> {
    const { Permission } = getIdentityContext();
    const rows = await Permission.findAll({ transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.PermissionRow);
  }

  async findByNames(names: string[], t: Transaction): Promise<UserManagementShape.PermissionRow[]> {
    const { Permission } = getIdentityContext();
    const rows = await Permission.findAll({ where: { name: names }, transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.PermissionRow);
  }
}
