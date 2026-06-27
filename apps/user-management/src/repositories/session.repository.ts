import type { Transaction } from 'sequelize';
import { SessionStatus } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/** Issued-session repository for the reference IdP. */
@provideSingleton(SessionRepository)
export class SessionRepository {
  async create(
    data: UserManagementShape.CreateSessionRow,
    t: Transaction,
  ): Promise<UserManagementShape.SessionRow> {
    const { Session } = getIdentityContext();
    const row = await Session.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.SessionRow;
  }

  async list(t: Transaction): Promise<UserManagementShape.SessionRow[]> {
    const { Session } = getIdentityContext();
    const rows = await Session.findAll({ order: [['created_at', 'DESC']], transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.SessionRow);
  }

  async revoke(id: string, t: Transaction): Promise<UserManagementShape.SessionRow | null> {
    const { Session } = getIdentityContext();
    const row = await Session.findByPk(id, { transaction: t });
    if (!row) return null;
    await row.update({ status: SessionStatus.Revoked, revoked_at: new Date() }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.SessionRow;
  }
}
