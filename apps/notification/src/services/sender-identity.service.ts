import { inject } from 'inversify';
import type { Transaction } from 'sequelize';
import type { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { EmailSenderIdentityRepository } from '../repositories/email-sender-identity.repository';

/**
 * Sender-identity resolver (G2) — turns a tenant's `email_sender_identities` row into the concrete
 * From / Reply-To the sender stamps on an `EmailMessage`, plus the tenant email master-switch. The
 * absence of a row is the DEFAULT-SEND case: master-switch ON, and From left null so the provider's
 * configured default (`SMTP_FROM` / `APP_NAME`) applies. Each tenant thus sends from its own identity
 * with a safe fallback, following an established default-From resolver + per-tenant override pattern.
 */
@provideSingleton(SenderIdentityService)
export class SenderIdentityService {
  constructor(
    @inject(EmailSenderIdentityRepository)
    private readonly repo: EmailSenderIdentityRepository,
  ) {}

  /** Compose `"Name" <addr>` / bare `<addr>` / null from a row's from_name + from_email. */
  private static composeFrom(row: NotificationShape.EmailSenderIdentityRow): string | null {
    if (!row.from_email) return null;
    return row.from_name ? `"${row.from_name}" <${row.from_email}>` : row.from_email;
  }

  /** Resolve the current tenant's sender identity (RLS-scoped via the ambient transaction). */
  async resolve(t: Transaction): Promise<NotificationShape.SenderIdentity> {
    const row = await this.repo.findForTenant(t);
    if (!row) {
      // No configured identity ⇒ default-send with provider-default From.
      return { from: null, replyTo: null, emailEnabled: true };
    }
    return {
      from: SenderIdentityService.composeFrom(row),
      replyTo: row.reply_to,
      emailEnabled: row.email_enabled,
    };
  }
}
