import type { Transaction } from 'sequelize';
import { InviteStatus } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/** Tenant-scoped invitation repository. */
@provideSingleton(InviteRepository)
export class InviteRepository {
  async list(t: Transaction): Promise<UserManagementShape.InviteRow[]> {
    const { Invite } = getIdentityContext();
    const rows = await Invite.findAll({ order: [['created_at', 'DESC']], transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.InviteRow);
  }

  async create(
    data: UserManagementShape.CreateInviteRow,
    t: Transaction,
  ): Promise<UserManagementShape.InviteRow> {
    const { Invite } = getIdentityContext();
    const row = await Invite.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.InviteRow;
  }

  async revoke(id: string, t: Transaction): Promise<UserManagementShape.InviteRow | null> {
    const { Invite } = getIdentityContext();
    const row = await Invite.findByPk(id, { transaction: t });
    if (!row) return null;
    await row.update({ status: InviteStatus.Revoked, revoked_at: new Date() }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.InviteRow;
  }
}
