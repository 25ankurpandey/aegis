import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/** Tenant-owned ABAC policy repository (PAP storage). */
@provideSingleton(PolicyRepository)
export class PolicyRepository {
  async list(t: Transaction): Promise<UserManagementShape.PolicyRow[]> {
    const { Policy } = getIdentityContext();
    const rows = await Policy.findAll({ order: [['priority', 'ASC']], transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.PolicyRow);
  }

  async create(
    data: UserManagementShape.CreatePolicyRow,
    t: Transaction,
  ): Promise<UserManagementShape.PolicyRow> {
    const { Policy } = getIdentityContext();
    const row = await Policy.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.PolicyRow;
  }

  async update(
    id: string,
    patch: UserManagementShape.UpdatePolicyRow,
    t: Transaction,
  ): Promise<UserManagementShape.PolicyRow | null> {
    const { Policy } = getIdentityContext();
    const row = await Policy.findByPk(id, { transaction: t });
    if (!row) return null;
    await row.update(patch, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.PolicyRow;
  }

  async delete(id: string, t: Transaction): Promise<boolean> {
    const { Policy } = getIdentityContext();
    const affected = await Policy.destroy({ where: { id }, transaction: t });
    return affected > 0;
  }
}
