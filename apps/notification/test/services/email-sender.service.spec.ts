import { EmailNotificationStatus } from '@aegis/shared-enums';
import type { NotificationShape } from '@aegis/shared-types';
import { EmailSenderService } from '../../src/services/email-sender.service';
import type { EmailNotificationLogRepository } from '../../src/repositories/email-notification-log.repository';
import type { EmailSuppressionRepository } from '../../src/repositories/email-suppression.repository';
import type { EmailProviderService } from '../../src/services/email-provider.service';
import type { SenderIdentityService } from '../../src/services/sender-identity.service';

/**
 * The email-plane send gate (G2/G3/G8): tenant master-switch → suppression list → recipient-domain
 * policy, all checked BEFORE the provider. Policy decisions are recorded as INTENTIONAL not-sent
 * (Disabled/Suppressed/Blocked) and never throw; per-tenant from/reply-to + html/attachments are
 * wired through to the provider on a real send.
 *
 * The env-driven gate is exercised here with a clean env (no allow/deny/prefix) so the DB gates
 * (master-switch, suppression) are isolated; EmailGatingPolicy's own branches are covered in
 * email-gating.spec.ts.
 */
describe('EmailSenderService.sendIdempotent (send gate)', () => {
  const tx = {} as never;
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Construct the policy with a clean env: no allow/deny lists, no prefix, prod-like (no auto-tag).
    process.env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  function content(
    over: Partial<NotificationShape.RenderedContent> = {},
  ): NotificationShape.RenderedContent {
    return { subject: 'Expense report approved', body: 'Your report was approved.', template: 'expense-approved', ...over };
  }

  function input(
    over: Partial<NotificationShape.SendIdempotentInput> = {},
  ): NotificationShape.SendIdempotentInput {
    return {
      tenantId: 't1',
      userId: 'u1',
      email: 'user@acme.com',
      idempotencyKey: 'email:expense/approved:r1:u1:c1',
      correlationId: 'c1',
      payload: { code: 'expense/approved' },
      content: content(),
      ...over,
    };
  }

  function logRow(
    over: Partial<NotificationShape.EmailNotificationLogRow> = {},
  ): NotificationShape.EmailNotificationLogRow {
    return {
      id: 'log-1',
      tenant_id: 't1',
      user_id: 'u1',
      email: 'user@acme.com',
      template_name: 'expense-approved',
      payload: {},
      status: EmailNotificationStatus.Pending,
      idempotency_key: 'email:expense/approved:r1:u1:c1',
      correlation_id: 'c1',
      error_message: null,
      sent_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...over,
    };
  }

  function makeRepo(row: NotificationShape.EmailNotificationLogRow): EmailNotificationLogRepository {
    return {
      findOrCreateForUpdate: jest.fn().mockResolvedValue(row),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      markPolicy: jest.fn().mockResolvedValue(undefined),
    } as unknown as EmailNotificationLogRepository;
  }

  function makeIdentity(
    over: Partial<NotificationShape.SenderIdentity> = {},
  ): SenderIdentityService {
    return {
      resolve: jest
        .fn()
        .mockResolvedValue({ from: null, replyTo: null, emailEnabled: true, ...over }),
    } as unknown as SenderIdentityService;
  }

  function makeSuppressions(suppressed: boolean): EmailSuppressionRepository {
    return {
      isSuppressed: jest.fn().mockResolvedValue(suppressed),
      add: jest.fn(),
    } as unknown as EmailSuppressionRepository;
  }

  it('sends when all gates pass and marks the row sent', async () => {
    const repo = makeRepo(logRow());
    const provider = { send: jest.fn().mockResolvedValue('ref') } as unknown as EmailProviderService;
    const sender = new EmailSenderService(repo, provider, makeIdentity(), makeSuppressions(false));

    await sender.sendIdempotent(input(), tx);

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@acme.com', subject: 'Expense report approved' }),
    );
    expect(repo.markSent).toHaveBeenCalledWith('log-1', expect.any(Date), tx);
    expect(repo.markPolicy).not.toHaveBeenCalled();
  });

  it('records Disabled (no provider call) when the tenant master-switch is off', async () => {
    const repo = makeRepo(logRow());
    const provider = { send: jest.fn() } as unknown as EmailProviderService;
    const sender = new EmailSenderService(
      repo,
      provider,
      makeIdentity({ emailEnabled: false }),
      makeSuppressions(false),
    );

    await sender.sendIdempotent(input(), tx);

    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.markPolicy).toHaveBeenCalledWith(
      'log-1',
      EmailNotificationStatus.Disabled,
      expect.stringContaining('master-switch'),
      tx,
    );
  });

  it('records Suppressed (no provider call) when the recipient is on the suppression list', async () => {
    const repo = makeRepo(logRow());
    const provider = { send: jest.fn() } as unknown as EmailProviderService;
    const sender = new EmailSenderService(repo, provider, makeIdentity(), makeSuppressions(true));

    await sender.sendIdempotent(input(), tx);

    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.markPolicy).toHaveBeenCalledWith(
      'log-1',
      EmailNotificationStatus.Suppressed,
      expect.stringContaining('suppression list'),
      tx,
    );
  });

  it('records Blocked (no provider call) when the recipient domain is deny-listed', async () => {
    process.env = { NODE_ENV: 'production', EMAIL_DENY_DOMAINS: 'acme.com' } as NodeJS.ProcessEnv;
    const repo = makeRepo(logRow());
    const provider = { send: jest.fn() } as unknown as EmailProviderService;
    const sender = new EmailSenderService(repo, provider, makeIdentity(), makeSuppressions(false));

    await sender.sendIdempotent(input(), tx);

    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.markPolicy).toHaveBeenCalledWith(
      'log-1',
      EmailNotificationStatus.Blocked,
      expect.stringContaining('deny-listed'),
      tx,
    );
  });

  it('applies the env subject prefix to the dispatched message', async () => {
    process.env = { EMAIL_SUBJECT_PREFIX: '[STAGING]' } as NodeJS.ProcessEnv;
    const repo = makeRepo(logRow());
    const provider = { send: jest.fn().mockResolvedValue('ref') } as unknown as EmailProviderService;
    const sender = new EmailSenderService(repo, provider, makeIdentity(), makeSuppressions(false));

    await sender.sendIdempotent(input(), tx);

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: '[STAGING] Expense report approved' }),
    );
  });

  it('stamps the per-tenant from/reply-to and carries html + attachments through to the provider', async () => {
    const repo = makeRepo(logRow());
    const provider = { send: jest.fn().mockResolvedValue('ref') } as unknown as EmailProviderService;
    const identity = makeIdentity({ from: '"Acme" <billing@acme.com>', replyTo: 'support@acme.com' });
    const sender = new EmailSenderService(repo, provider, identity, makeSuppressions(false));

    const attachments = [{ filename: 'report.pdf', content: Buffer.from('x'), contentType: 'application/pdf' }];
    await sender.sendIdempotent(
      input({ content: content({ html: '<p>Approved</p>', attachments }) }),
      tx,
    );

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Acme" <billing@acme.com>',
        replyTo: 'support@acme.com',
        html: '<p>Approved</p>',
        attachments,
      }),
    );
  });

  it('short-circuits (no provider call, no re-mark) when the row is already a terminal policy status', async () => {
    const repo = makeRepo(logRow({ status: EmailNotificationStatus.Suppressed }));
    const provider = { send: jest.fn() } as unknown as EmailProviderService;
    const sender = new EmailSenderService(repo, provider, makeIdentity(), makeSuppressions(false));

    await sender.sendIdempotent(input(), tx);

    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.markPolicy).not.toHaveBeenCalled();
    expect(repo.markSent).not.toHaveBeenCalled();
  });

  it('marks failed and re-throws when the provider throws (transport error, not policy)', async () => {
    const repo = makeRepo(logRow());
    const provider = {
      send: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as EmailProviderService;
    const sender = new EmailSenderService(repo, provider, makeIdentity(), makeSuppressions(false));

    await expect(sender.sendIdempotent(input(), tx)).rejects.toThrow('connection refused');
    expect(repo.markFailed).toHaveBeenCalledWith('log-1', 'connection refused', tx);
  });
});
