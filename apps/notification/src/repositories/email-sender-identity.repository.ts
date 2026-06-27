import { type Transaction } from 'sequelize';
import { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getNotificationContext } from '../models/database-context';

/**
 * DAL for `email_sender_identities` (G2) — ONE row per tenant (from/reply-to + email master-switch).
 * Every method takes the ambient RLS-scoped `Transaction`, so a tenant only ever reads its own row.
 * The absence of a row is the default-send case (master-switch ON, provider default From).
 */
@provideSingleton(EmailSenderIdentityRepository)
export class EmailSenderIdentityRepository {
  /** The tenant's sender-identity row, or null when none has been configured (default-send). */
  async findForTenant(t: Transaction): Promise<NotificationShape.EmailSenderIdentityRow | null> {
    const { EmailSenderIdentity } = getNotificationContext();
    const row = await EmailSenderIdentity.findOne({ transaction: t });
    return row ? (row.get({ plain: true }) as NotificationShape.EmailSenderIdentityRow) : null;
  }

  /** Idempotent upsert of the tenant's single sender-identity / master-switch row. */
  async upsert(
    input: NotificationShape.UpsertSenderIdentityInput,
    t: Transaction,
  ): Promise<NotificationShape.EmailSenderIdentityRow> {
    const { EmailSenderIdentity } = getNotificationContext();
    const existing = await EmailSenderIdentity.findOne({ transaction: t });
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (input.from_name !== undefined) patch.from_name = input.from_name;
      if (input.from_email !== undefined) patch.from_email = input.from_email;
      if (input.reply_to !== undefined) patch.reply_to = input.reply_to;
      if (input.email_enabled !== undefined) patch.email_enabled = input.email_enabled;
      await existing.update(patch, { transaction: t });
      return existing.get({ plain: true }) as NotificationShape.EmailSenderIdentityRow;
    }
    const row = await EmailSenderIdentity.create(
      {
        tenant_id: input.tenant_id,
        from_name: input.from_name ?? null,
        from_email: input.from_email ?? null,
        reply_to: input.reply_to ?? null,
        email_enabled: input.email_enabled ?? true,
      },
      { transaction: t },
    );
    return row.get({ plain: true }) as NotificationShape.EmailSenderIdentityRow;
  }
}
