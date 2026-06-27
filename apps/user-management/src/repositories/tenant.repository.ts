import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/** Tenant reads. Tenant RLS means callers only see their current tenant. */
@provideSingleton(TenantRepository)
export class TenantRepository {
  async findById(id: string, t: Transaction): Promise<UserManagementShape.TenantRow | null> {
    const { Tenant } = getIdentityContext();
    const row = await Tenant.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as UserManagementShape.TenantRow) : null;
  }
}
