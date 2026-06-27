import { type Transaction } from 'sequelize';
import { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getNotificationContext } from '../models/database-context';

/** Normalize an address for suppression matching (case/space-insensitive). */
function normalize(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * DAL for `email_suppressions` (G8). Every method takes the ambient RLS-scoped `Transaction` opened
 * by the service via `withTenantTransaction`, so a tenant only ever sees its own suppression rows.
 * The sender's pre-send gate calls `isSuppressed`; `add` is the seam a future bounce/complaint
 * ingestion webhook will call (documented follow-up).
 */
@provideSingleton(EmailSuppressionRepository)
export class EmailSuppressionRepository {
  /** Is this address suppressed for the current tenant? Point lookup on the (tenant, address) UNIQUE. */
  async isSuppressed(address: string, t: Transaction): Promise<boolean> {
    const { EmailSuppression } = getNotificationContext();
    const row = await EmailSuppression.findOne({
      where: { address: normalize(address) },
      transaction: t,
    });
    return row !== null;
  }

  /**
   * Idempotently add a suppression entry (bounce/complaint/unsubscribe). Re-adding an existing
   * address is a no-op that returns the existing row (the (tenant, address) UNIQUE backs this).
   */
  async add(
    input: NotificationShape.AddSuppressionInput,
    t: Transaction,
  ): Promise<NotificationShape.EmailSuppressionRow> {
    const { EmailSuppression } = getNotificationContext();
    const address = normalize(input.address);
    const existing = await EmailSuppression.findOne({ where: { address }, transaction: t });
    if (existing) return existing.get({ plain: true }) as NotificationShape.EmailSuppressionRow;

    const row = await EmailSuppression.create(
      {
        tenant_id: input.tenant_id,
        address,
        reason: input.reason,
        source: input.source ?? null,
      },
      { transaction: t },
    );
    return row.get({ plain: true }) as NotificationShape.EmailSuppressionRow;
  }
}
