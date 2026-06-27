import type { Transaction } from 'sequelize';
import { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getNotificationContext } from '../models/database-context';

/**
 * Data access for the notification aggregate (the `notifications` table — the in-app inbox). Every
 * method takes the ambient RLS-scoped `Transaction` (the SERVICE opens it via
 * `withTenantTransaction`), so a tenant only ever sees its own rows.
 */
@provideSingleton(NotificationRepository)
export class NotificationRepository {
  /** Idempotent insert keyed on (tenant_id, user_id, code, correlation_id) — no duplicate badge on redelivery. */
  async createIfAbsent(
    data: NotificationShape.CreateNotificationInput,
    t: Transaction,
  ): Promise<NotificationShape.NotificationRow> {
    const { Notification } = getNotificationContext();
    const where: Record<string, unknown> = {
      user_id: data.user_id,
      code: data.code,
      correlation_id: data.correlation_id,
    };
    const existing = await Notification.findOne({ where, transaction: t });
    if (existing) return existing.get({ plain: true }) as NotificationShape.NotificationRow;
    const row = await Notification.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as NotificationShape.NotificationRow;
  }

  /** Caller's own inbox, newest first, RLS-scoped to tenant + filtered to user_id. */
  async listForUser(
    params: NotificationShape.ListNotificationsParams,
    t: Transaction,
  ): Promise<{ rows: NotificationShape.NotificationRow[]; count: number }> {
    const { Notification } = getNotificationContext();
    const result = await Notification.findAndCountAll({
      where: { user_id: params.userId },
      order: [['created_at', 'DESC']],
      limit: params.limit,
      offset: params.offset,
      transaction: t,
    });
    return {
      rows: result.rows.map((r) => r.get({ plain: true }) as NotificationShape.NotificationRow),
      count: result.count,
    };
  }

  async findByIdForUser(
    id: string,
    userId: string,
    t: Transaction,
  ): Promise<NotificationShape.NotificationRow | null> {
    const { Notification } = getNotificationContext();
    const row = await Notification.findOne({ where: { id, user_id: userId }, transaction: t });
    return row ? (row.get({ plain: true }) as NotificationShape.NotificationRow) : null;
  }

  async countUnreadForUser(userId: string, t: Transaction): Promise<number> {
    const { Notification } = getNotificationContext();
    return Notification.count({ where: { user_id: userId, read_at: null }, transaction: t });
  }

  /** Mark one of the caller's notifications read (sets read_at). Returns the updated row or null. */
  async markRead(
    id: string,
    userId: string,
    t: Transaction,
  ): Promise<NotificationShape.NotificationRow | null> {
    const { Notification } = getNotificationContext();
    const row = await Notification.findOne({ where: { id, user_id: userId }, transaction: t });
    if (!row) return null;
    const plain = row.get({ plain: true }) as NotificationShape.NotificationRow;
    if (plain.read_at) return plain; // already read — idempotent
    await row.update({ read_at: new Date() }, { transaction: t });
    return row.get({ plain: true }) as NotificationShape.NotificationRow;
  }

  /** Mark every unread notification owned by the caller as read. */
  async markAllRead(userId: string, readAt: Date, t: Transaction): Promise<number> {
    const { Notification } = getNotificationContext();
    const [updated] = await Notification.update(
      { read_at: readAt },
      { where: { user_id: userId, read_at: null }, transaction: t },
    );
    return updated;
  }
}
