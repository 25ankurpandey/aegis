import { Op, type Transaction } from 'sequelize';
import { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getNotificationContext } from '../models/database-context';

/**
 * DAL for `notification_preferences` (W3-10). Every method takes the ambient RLS-scoped `Transaction`
 * opened by the service via `withTenantTransaction`, so a tenant only ever sees its own rows. The
 * consumer's channel gate is DEFAULT-ON: a (user, event_type, channel) is delivered unless an
 * explicit row disables it. A user-specific row overrides the tenant-wide default (user_id NULL).
 */
@provideSingleton(NotificationPreferenceRepository)
export class NotificationPreferenceRepository {
  /**
   * Is the channel enabled for this (user, event_type)? DEFAULT-ON: missing row ⇒ true. A
   * user-specific row wins over a tenant-wide default (user_id NULL); if neither exists, true.
   */
  async isChannelEnabled(
    lookup: NotificationShape.PreferenceLookup,
    t: Transaction,
  ): Promise<boolean> {
    const { NotificationPreference } = getNotificationContext();
    const rows = await NotificationPreference.findAll({
      where: {
        event_type: lookup.eventType,
        channel: lookup.channel,
        user_id: { [Op.or]: [lookup.userId, null] },
      },
      transaction: t,
    });
    if (rows.length === 0) return true; // default-on

    const plain = rows.map(
      (r) => r.get({ plain: true }) as NotificationShape.NotificationPreferenceRow,
    );
    // User-specific row overrides the tenant-wide default.
    const userRow = plain.find((r) => r.user_id === lookup.userId);
    const effective = userRow ?? plain.find((r) => r.user_id === null);
    return effective ? effective.enabled : true;
  }

  /** Idempotent upsert of one (tenant, user, event_type, channel) preference. */
  async upsert(
    input: NotificationShape.UpsertPreferenceInput,
    t: Transaction,
  ): Promise<NotificationShape.NotificationPreferenceRow> {
    const { NotificationPreference } = getNotificationContext();
    const where = {
      event_type: input.event_type,
      channel: input.channel,
      user_id: input.user_id,
    };
    const existing = await NotificationPreference.findOne({ where, transaction: t });
    if (existing) {
      await existing.update({ enabled: input.enabled }, { transaction: t });
      return existing.get({ plain: true }) as NotificationShape.NotificationPreferenceRow;
    }
    const row = await NotificationPreference.create({ ...input }, { transaction: t });
    return row.get({ plain: true }) as NotificationShape.NotificationPreferenceRow;
  }

  /** List a user's effective preferences (RLS-scoped to tenant), for a settings view. */
  async listForUser(
    userId: string,
    t: Transaction,
  ): Promise<NotificationShape.NotificationPreferenceRow[]> {
    const { NotificationPreference } = getNotificationContext();
    const rows = await NotificationPreference.findAll({
      where: { user_id: { [Op.or]: [userId, null] } },
      order: [['event_type', 'ASC']],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as NotificationShape.NotificationPreferenceRow);
  }
}
