import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for `team_members` (Wave-6). Every method takes the ambient RLS-scoped `Transaction`
 * opened by the service via `withTenantTransaction`.
 */
@provideSingleton(TeamMemberRepository)
export class TeamMemberRepository {
  /** Members of one team. */
  async listByTeam(teamId: string, t: Transaction): Promise<UserManagementShape.TeamMemberRow[]> {
    const { TeamMember } = getIdentityContext();
    const rows = await TeamMember.findAll({ where: { team_id: teamId }, transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.TeamMemberRow);
  }

  /** Add a user to a team (idempotent on the (team_id, user_id) unique key). */
  async add(
    data: UserManagementShape.AddTeamMemberInput,
    t: Transaction,
  ): Promise<UserManagementShape.TeamMemberRow> {
    const { TeamMember } = getIdentityContext();
    const row = await TeamMember.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.TeamMemberRow;
  }

  /** Remove a user from a team. */
  async remove(teamId: string, userId: string, t: Transaction): Promise<number> {
    const { TeamMember } = getIdentityContext();
    return TeamMember.destroy({ where: { team_id: teamId, user_id: userId }, transaction: t });
  }
}
