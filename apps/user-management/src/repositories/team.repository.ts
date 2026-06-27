import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for the `teams` catalog (Wave-6). Tenant-admin owns team CRUD; every method takes the
 * ambient RLS-scoped `Transaction` opened by the service via `withTenantTransaction`.
 */
@provideSingleton(TeamRepository)
export class TeamRepository {
  async list(t: Transaction): Promise<UserManagementShape.TeamRow[]> {
    const { Team } = getIdentityContext();
    const rows = await Team.findAll({ transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.TeamRow);
  }

  async findById(id: string, t: Transaction): Promise<UserManagementShape.TeamRow | null> {
    const { Team } = getIdentityContext();
    const row = await Team.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as UserManagementShape.TeamRow) : null;
  }

  async create(
    data: UserManagementShape.CreateTeamInput,
    t: Transaction,
  ): Promise<UserManagementShape.TeamRow> {
    const { Team } = getIdentityContext();
    const row = await Team.create({ ...data, is_active: true }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.TeamRow;
  }

  async update(
    id: string,
    patch: UserManagementShape.UpdateTeamInput,
    t: Transaction,
  ): Promise<UserManagementShape.TeamRow | null> {
    const { Team } = getIdentityContext();
    const row = await Team.findByPk(id, { transaction: t });
    if (!row) return null;
    await row.update(patch, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.TeamRow;
  }

  async delete(id: string, t: Transaction): Promise<number> {
    const { Team } = getIdentityContext();
    return Team.destroy({ where: { id }, transaction: t });
  }
}
