import { inject } from 'inversify';
import type { Transaction } from 'sequelize';
import { Logger } from '@aegis/service-core';
import { EmailNotificationStatus } from '@aegis/shared-enums';
import type { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { EmailNotificationLogRepository } from '../repositories/email-notification-log.repository';
import { EmailSuppressionRepository } from '../repositories/email-suppression.repository';
import { EmailProviderService } from './email-provider.service';
import { SenderIdentityService } from './sender-identity.service';
import { EmailGatingPolicy } from './email-gating';

/**
 * Idempotent email send (§5). At-least-once at the bus, exactly-once at the recipient:
 *  1. findOrCreateForUpdate locks the single row for the logical event (idempotency_key UNIQUE).
 *  2. short-circuit if the row is already terminal (sent OR a prior policy decision).
 *  3. run the SEND GATE (G2/G3/G8) before touching the provider:
 *       a. tenant email master-switch off  ⇒ Disabled
 *       b. recipient on the suppression list ⇒ Suppressed
 *       c. recipient domain deny-/not-allow-listed ⇒ Blocked
 *     each is recorded as an INTENTIONAL not-sent (distinct from Failed), and DOES NOT throw —
 *     a policy decision is final, not a transient error to retry.
 *  4. otherwise send via the provider (stamping per-tenant from/reply-to, env subject prefix, and
 *     any html/attachments); mark 'sent' on success, 'failed' (with error_message) on exception.
 * The row is never left in 'pending'. Runs inside the caller's RLS-scoped transaction.
 */
@provideSingleton(EmailSenderService)
export class EmailSenderService {
  private readonly gating: EmailGatingPolicy;

  constructor(
    @inject(EmailNotificationLogRepository) private readonly repo: EmailNotificationLogRepository,
    @inject(EmailProviderService) private readonly provider: EmailProviderService,
    @inject(SenderIdentityService) private readonly identity: SenderIdentityService,
    @inject(EmailSuppressionRepository) private readonly suppressions: EmailSuppressionRepository,
  ) {
    // Env-driven allow/deny domains + non-prod subject prefix (resolved once at construction).
    this.gating = new EmailGatingPolicy();
  }

  /** True once the ledger row reached ANY terminal state (sent or an earlier policy decision). */
  private static isTerminal(status: EmailNotificationStatus): boolean {
    return status !== EmailNotificationStatus.Pending && status !== EmailNotificationStatus.Failed;
  }

  async sendIdempotent(input: NotificationShape.SendIdempotentInput, t: Transaction): Promise<void> {
    const log = await this.repo.findOrCreateForUpdate(
      {
        tenant_id: input.tenantId,
        user_id: input.userId,
        email: input.email,
        template_name: input.content.template,
        payload: input.payload,
        idempotency_key: input.idempotencyKey,
        correlation_id: input.correlationId,
      },
      t,
    );

    // Short-circuit: a prior delivery succeeded OR a prior policy decision already settled this row.
    if (EmailSenderService.isTerminal(log.status)) {
      Logger.debug('email send short-circuited (already terminal)', {
        idempotencyKey: input.idempotencyKey,
        status: log.status,
      });
      return;
    }

    // --- SEND GATE (G2/G3/G8) — checked BEFORE the provider; policy decisions never throw. ---

    // (a) Tenant email master-switch (DB). Off ⇒ Disabled.
    const sender = await this.identity.resolve(t);
    if (!sender.emailEnabled) {
      await this.repo.markPolicy(
        log.id,
        EmailNotificationStatus.Disabled,
        'disabled: tenant email master-switch is off',
        t,
      );
      Logger.info('email suppressed (tenant master-switch off)', {
        idempotencyKey: input.idempotencyKey,
      });
      return;
    }

    // (b) Suppression list (DB). Hit ⇒ Suppressed.
    if (await this.suppressions.isSuppressed(input.email, t)) {
      await this.repo.markPolicy(
        log.id,
        EmailNotificationStatus.Suppressed,
        'suppressed: recipient on the tenant suppression list',
        t,
      );
      Logger.info('email suppressed (on suppression list)', {
        idempotencyKey: input.idempotencyKey,
      });
      return;
    }

    // (c) Recipient-domain allow/deny + subject prefix (env). Block ⇒ Blocked; else prefixed subject.
    const decision = this.gating.evaluate(input.email, input.content.subject);
    if (!decision.allowed) {
      await this.repo.markPolicy(log.id, decision.status, decision.reason, t);
      Logger.info('email blocked by domain policy', {
        idempotencyKey: input.idempotencyKey,
        reason: decision.reason,
      });
      return;
    }

    // --- Dispatch (per-tenant identity + rich parts wired through to the provider). ---
    try {
      await this.provider.send({
        to: input.email,
        subject: decision.subject,
        body: input.content.body,
        ...(sender.from ? { from: sender.from } : {}),
        ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
        ...(input.content.html ? { html: input.content.html } : {}),
        ...(input.content.attachments ? { attachments: input.content.attachments } : {}),
      });
      await this.repo.markSent(log.id, new Date(), t);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed(log.id, message, t);
      // Bubble so the bus applies its bounded retry; on exhaustion the bus dead-letters the envelope
      // (Kafka: `<topic>.dlq`; in-process: the DeadLetterSink) — the failure is recorded, not lost.
      throw err;
    }
  }
}
