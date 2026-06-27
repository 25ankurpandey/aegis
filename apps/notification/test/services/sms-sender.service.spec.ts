import { EmailNotificationStatus } from '@aegis/shared-enums';
import type { NotificationShape } from '@aegis/shared-types';
import { SmsSenderService } from '../../src/services/sms-sender.service';
import type { EmailNotificationLogRepository } from '../../src/repositories/email-notification-log.repository';
import type { SmsProviderService } from '../../src/services/sms-provider.service';

/**
 * W3-12: the SMS sender mirrors the email sender's idempotent lifecycle on the shared (channel-
 * agnostic) ledger — short-circuit on an already-sent row, mark sent on success, mark failed + bubble
 * on a provider exception.
 */
describe('SmsSenderService.sendIdempotent', () => {
  const tx = {} as never;

  function makeInput(): NotificationShape.SendSmsInput {
    return {
      tenantId: 't1',
      userId: 'u1',
      phone: '+15551230000',
      idempotencyKey: 'sms:expense/approved:r1:u1:c1',
      correlationId: 'c1',
      payload: { code: 'expense/approved' },
      content: { subject: 's', body: 'your report was approved', template: 'expense-approved' },
    };
  }

  function logRow(
    over: Partial<NotificationShape.EmailNotificationLogRow>,
  ): NotificationShape.EmailNotificationLogRow {
    return {
      id: 'log-1',
      tenant_id: 't1',
      user_id: 'u1',
      email: '+15551230000',
      template_name: 'expense-approved',
      payload: {},
      status: EmailNotificationStatus.Pending,
      idempotency_key: 'sms:expense/approved:r1:u1:c1',
      correlation_id: 'c1',
      error_message: null,
      sent_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...over,
    };
  }

  it('sends when the ledger row is pending and marks it sent', async () => {
    const repo = {
      findOrCreateForUpdate: jest.fn().mockResolvedValue(logRow({})),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn(),
    } as unknown as EmailNotificationLogRepository;
    const provider = { send: jest.fn().mockResolvedValue('sms_ref') } as unknown as SmsProviderService;

    const sender = new SmsSenderService(repo, provider);
    await sender.sendIdempotent(makeInput(), tx);

    expect(provider.send).toHaveBeenCalledWith({ to: '+15551230000', body: 'your report was approved' });
    expect(repo.markSent).toHaveBeenCalledWith('log-1', expect.any(Date), tx);
  });

  it('short-circuits (no provider call) when the row is already sent', async () => {
    const repo = {
      findOrCreateForUpdate: jest.fn().mockResolvedValue(logRow({ status: EmailNotificationStatus.Sent })),
      markSent: jest.fn(),
      markFailed: jest.fn(),
    } as unknown as EmailNotificationLogRepository;
    const provider = { send: jest.fn() } as unknown as SmsProviderService;

    const sender = new SmsSenderService(repo, provider);
    await sender.sendIdempotent(makeInput(), tx);

    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.markSent).not.toHaveBeenCalled();
  });

  it('marks failed and re-throws when the provider throws', async () => {
    const repo = {
      findOrCreateForUpdate: jest.fn().mockResolvedValue(logRow({})),
      markSent: jest.fn(),
      markFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as EmailNotificationLogRepository;
    const provider = {
      send: jest.fn().mockRejectedValue(new Error('gateway down')),
    } as unknown as SmsProviderService;

    const sender = new SmsSenderService(repo, provider);
    await expect(sender.sendIdempotent(makeInput(), tx)).rejects.toThrow('gateway down');
    expect(repo.markFailed).toHaveBeenCalledWith('log-1', 'gateway down', tx);
  });
});
