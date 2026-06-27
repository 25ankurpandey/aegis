import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for `team_tags` — which catalog tags a team may apply (Wave-6). Every method takes the
 * ambient RLS-scoped `Transaction` opened by the service via `withTenantTransaction`.
 */
@provideSingleton(TeamTagRepository)
export class TeamTagRepository {
  /** Tags mapped to one team. */
  async listByTeam(teamId: string, t: Transaction): Promise<UserManagementShape.TeamTagRow[]> {
    const { TeamTag } = getIdentityContext();
    const rows = await TeamTag.findAll({ where: { team_id: teamId }, transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.TeamTagRow);
  }

  /** Replace a team's tag mapping with exactly the given tag ids. */
  async setTags(
    tenantId: string,
    teamId: string,
    tagIds: string[],
    t: Transaction,
  ): Promise<void> {
    const { TeamTag } = getIdentityContext();
    await TeamTag.destroy({ where: { team_id: teamId }, transaction: t });
    if (tagIds.length) {
      await TeamTag.bulkCreate(
        tagIds.map((tag_id) => ({ tenant_id: tenantId, team_id: teamId, tag_id })),
        { transaction: t },
      );
    }
  }
}
