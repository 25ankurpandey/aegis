import { inject } from 'inversify';
import type { Transaction } from 'sequelize';
import { Logger } from '@aegis/service-core';
import { EmailNotificationStatus } from '@aegis/shared-enums';
import type { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { EmailNotificationLogRepository } from '../repositories/email-notification-log.repository';
import { SmsProviderService } from './sms-provider.service';

/**
 * Idempotent SMS send (W3-12) — the SMS twin of `EmailSenderService`. It reuses the
 * `email_notification_logs` ledger as a CHANNEL-AGNOSTIC delivery ledger: the destination address is
 * stored in the `email` column generically and the channel is encoded into the `idempotency_key`
 * (the caller prefixes it with `sms:`), so an email and an SMS for the same logical event get
 * distinct ledger rows and each is exactly-once. The send walks the same pending → sent/failed
 * lifecycle and bubbles failures so the bus applies its bounded retry + DLQ.
 */
@provideSingleton(SmsSenderService)
export class SmsSenderService {
  constructor(
    @inject(EmailNotificationLogRepository) private readonly repo: EmailNotificationLogRepository,
    @inject(SmsProviderService) private readonly provider: SmsProviderService,
  ) {}

  async sendIdempotent(input: NotificationShape.SendSmsInput, t: Transaction): Promise<void> {
    const log = await this.repo.findOrCreateForUpdate(
      {
        tenant_id: input.tenantId,
        user_id: input.userId,
        // Channel-agnostic ledger: the SMS destination lives in the `email`/address column.
        email: input.phone,
        template_name: input.content.template,
        payload: input.payload,
        idempotency_key: input.idempotencyKey,
        correlation_id: input.correlationId,
      },
      t,
    );

    if (log.status === EmailNotificationStatus.Sent) {
      Logger.debug('sms send short-circuited (already sent)', {
        idempotencyKey: input.idempotencyKey,
      });
      return;
    }

    try {
      await this.provider.send({ to: input.phone, body: input.content.body });
      await this.repo.markSent(log.id, new Date(), t);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed(log.id, message, t);
      throw err;
    }
  }
}
