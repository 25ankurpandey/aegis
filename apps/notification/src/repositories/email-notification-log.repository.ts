import { type Transaction } from 'sequelize';
import type { WhereOptions } from 'sequelize';
import { EmailNotificationStatus } from '@aegis/shared-enums';
import { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getNotificationContext } from '../models/database-context';

/**
 * DAL for `email_notification_logs` — the linchpin of exactly-once email. Every method takes the
 * ambient RLS-scoped `Transaction` opened by the service via `withTenantTransaction`.
 * `findOrCreateForUpdate` locks the single row for a logical event (idempotency_key UNIQUE).
 */
@provideSingleton(EmailNotificationLogRepository)
export class EmailNotificationLogRepository {
  /**
   * Get (or create) the single log row for this logical event, taking a row lock (FOR UPDATE)
   * so concurrent redeliveries serialize and the loser re-reads the winner's terminal status.
   */
  async findOrCreateForUpdate(
    input: NotificationShape.FindOrCreateEmailLogInput,
    t: Transaction,
  ): Promise<NotificationShape.EmailNotificationLogRow> {
    const { EmailNotificationLog } = getNotificationContext();
    const existing = await EmailNotificationLog.findOne({
      where: { idempotency_key: input.idempotency_key },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (existing) return existing.get({ plain: true }) as NotificationShape.EmailNotificationLogRow;

    const row = await EmailNotificationLog.create(
      { ...input, status: EmailNotificationStatus.Pending },
      { transaction: t },
    );
    return row.get({ plain: true }) as NotificationShape.EmailNotificationLogRow;
  }

  async markSent(id: string, sentAt: Date, t: Transaction): Promise<void> {
    const { EmailNotificationLog } = getNotificationContext();
    await EmailNotificationLog.update(
      { status: EmailNotificationStatus.Sent, sent_at: sentAt, error_message: null },
      { where: { id }, transaction: t },
    );
  }

  async markFailed(id: string, errorMessage: string, t: Transaction): Promise<void> {
    const { EmailNotificationLog } = getNotificationContext();
    await EmailNotificationLog.update(
      { status: EmailNotificationStatus.Failed, error_message: errorMessage },
      { where: { id }, transaction: t },
    );
  }

  /**
   * Mark a row with a POLICY status (Suppressed/Disabled/Blocked) — a send that was INTENTIONALLY
   * not attempted (gate/suppression hit), auditable as distinct from a transport `Failed`. The
   * `reason` is stored in `error_message` for the compliance view (e.g. "suppressed: bounce"); it is
   * not a transport error. No `sent_at` is set (the message was never dispatched).
   */
  async markPolicy(
    id: string,
    status:
      | EmailNotificationStatus.Suppressed
      | EmailNotificationStatus.Disabled
      | EmailNotificationStatus.Blocked,
    reason: string,
    t: Transaction,
  ): Promise<void> {
    const { EmailNotificationLog } = getNotificationContext();
    await EmailNotificationLog.update(
      { status, error_message: reason, sent_at: null },
      { where: { id }, transaction: t },
    );
  }

  /** Tenant compliance view — RLS-scoped list of email logs (admin), newest first. */
  async listForTenant(
    params: NotificationShape.ListEmailLogsParams,
    t: Transaction,
  ): Promise<{ rows: NotificationShape.EmailNotificationLogRow[]; count: number }> {
    const { EmailNotificationLog } = getNotificationContext();
    const where: WhereOptions = {};
    if (params.status) where['status'] = params.status;
    if (params.userId) where['user_id'] = params.userId;
    const result = await EmailNotificationLog.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: params.limit,
      offset: params.offset,
      transaction: t,
    });
    return {
      rows: result.rows.map(
        (r) => r.get({ plain: true }) as NotificationShape.EmailNotificationLogRow,
      ),
      count: result.count,
    };
  }
}
