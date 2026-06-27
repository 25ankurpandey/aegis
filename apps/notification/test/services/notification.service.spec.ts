import { RequestContext } from '@aegis/service-core';
import { EmailNotificationStatus, NotificationCode, NotificationChannel } from '@aegis/shared-enums';
import { NotificationConstants } from '@aegis/shared-constants';
import type { NotificationShape } from '@aegis/shared-types';

// Stub the tenant transaction so the gating logic runs without a live DB (the body is invoked with a
// fake transaction). The mock is hoisted above the service import by jest.
jest.mock('@aegis/db', () => ({
  withTenantTransaction: (fn: (t: never) => Promise<unknown>) => fn({} as never),
}));

import { NotificationService } from '../../src/services/notification.service';
import type { NotificationRepository } from '../../src/repositories/notification.repository';
import type { EmailNotificationLogRepository } from '../../src/repositories/email-notification-log.repository';
import type { NotificationPreferenceRepository } from '../../src/repositories/notification-preference.repository';
import type { EmailSenderService } from '../../src/services/email-sender.service';
import type { SmsSenderService } from '../../src/services/sms-sender.service';
import type { RecipientResolverService } from '../../src/services/recipient-resolver.service';

/**
 * Service-level wiring for W3-09 (fan-out) + W3-10 (per-channel preference gate) + W3-12 (SMS
 * channel). `withTenantTransaction` is stubbed to invoke the body with a fake transaction so the
 * tests exercise the gating logic without a live DB.
 */
const MESSAGE: NotificationShape.NotificationMessage = {
  code: NotificationCode.ExpenseApproved,
  reportId: 'r1',
  approvedBy: 'mgr',
  amountMinor: 1000,
};

const CTX = {
  tenantId: 'tenant-1',
  correlationId: 'corr-1',
  sourceService: undefined as never,
  startedAt: Date.now(),
};

function build(opts: {
  recipients: NotificationShape.Recipient[];
  enabled?: (c: NotificationChannel) => boolean;
}) {
  const repo = {
    createIfAbsent: jest.fn().mockResolvedValue(undefined),
    countUnreadForUser: jest.fn().mockResolvedValue(3),
    markAllRead: jest.fn().mockResolvedValue(2),
  } as unknown as NotificationRepository;
  const emailLogs = {
    listForTenant: jest.fn().mockResolvedValue({ rows: [{ id: 'log-1' }], count: 1 }),
  } as unknown as EmailNotificationLogRepository;
  const emailSender = { sendIdempotent: jest.fn().mockResolvedValue(undefined) } as unknown as EmailSenderService;
  const smsSender = { sendIdempotent: jest.fn().mockResolvedValue(undefined) } as unknown as SmsSenderService;
  const prefs = {
    isChannelEnabled: jest.fn(async (l: NotificationShape.PreferenceLookup) =>
      opts.enabled ? opts.enabled(l.channel) : true,
    ),
  } as unknown as NotificationPreferenceRepository;
  const resolver = {
    resolve: jest.fn().mockResolvedValue(opts.recipients),
  } as unknown as RecipientResolverService;

  const service = new NotificationService(repo, emailLogs, emailSender, smsSender, prefs, resolver);
  return { service, repo, emailLogs, emailSender, smsSender, prefs, resolver };
}

describe('NotificationService channel fan-out + gating', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fans out one dispatch per resolved recipient (W3-09)', async () => {
    const { service, repo, resolver } = build({
      recipients: [{ userId: 'a' }, { userId: 'b' }],
    });
    await RequestContext.run(CTX, () =>
      service.resolveAndDispatch(MESSAGE, { kind: 'role', role: 'admin' }),
    );
    expect(resolver.resolve).toHaveBeenCalledWith({ kind: 'role', role: 'admin' });
    expect(repo.createIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('delivers in-app + email + sms when the recipient has both addresses and all are enabled', async () => {
    const { service, repo, emailSender, smsSender } = build({
      recipients: [{ userId: 'a', email: 'a@x.com', phone: '+1999' }],
    });
    await RequestContext.run(CTX, () =>
      service.resolveAndDispatch(MESSAGE, { kind: 'user', userId: 'a' }),
    );
    expect(repo.createIfAbsent).toHaveBeenCalledTimes(1);
    expect(emailSender.sendIdempotent).toHaveBeenCalledTimes(1);
    expect(smsSender.sendIdempotent).toHaveBeenCalledTimes(1);
    // Email/SMS idempotency keys are channel-prefixed so they get distinct ledger rows.
    expect((emailSender.sendIdempotent as jest.Mock).mock.calls[0][0].idempotencyKey).toMatch(/^email:/);
    expect((smsSender.sendIdempotent as jest.Mock).mock.calls[0][0].idempotencyKey).toMatch(/^sms:/);
  });

  it('suppresses a channel the recipient has opted out of (W3-10)', async () => {
    const { service, repo, emailSender, smsSender } = build({
      recipients: [{ userId: 'a', email: 'a@x.com', phone: '+1999' }],
      enabled: (c) => c !== NotificationChannel.Email, // email off, in-app + sms on
    });
    await RequestContext.run(CTX, () =>
      service.resolveAndDispatch(MESSAGE, { kind: 'user', userId: 'a' }),
    );
    expect(repo.createIfAbsent).toHaveBeenCalledTimes(1);
    expect(emailSender.sendIdempotent).not.toHaveBeenCalled();
    expect(smsSender.sendIdempotent).toHaveBeenCalledTimes(1);
  });

  it('skips email/sms when the recipient has no address even if the channel is enabled', async () => {
    const { service, emailSender, smsSender } = build({ recipients: [{ userId: 'a' }] });
    await RequestContext.run(CTX, () =>
      service.resolveAndDispatch(MESSAGE, { kind: 'user', userId: 'a' }),
    );
    expect(emailSender.sendIdempotent).not.toHaveBeenCalled();
    expect(smsSender.sendIdempotent).not.toHaveBeenCalled();
  });

  it('respects the per-code kill-switch (no resolve, no dispatch)', async () => {
    const { service, resolver, repo } = build({ recipients: [{ userId: 'a' }] });
    const disabled = jest
      .spyOn(NotificationConstants, 'isCodeEnabled')
      .mockReturnValue(false);
    await RequestContext.run(CTX, () =>
      service.resolveAndDispatch(MESSAGE, { kind: 'user', userId: 'a' }),
    );
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(repo.createIfAbsent).not.toHaveBeenCalled();
    disabled.mockRestore();
  });

  it('returns the authenticated user unread count', async () => {
    const { service, repo } = build({ recipients: [] });
    const result = await RequestContext.run({ ...CTX, userId: 'user-1' }, () =>
      service.unreadCountForUser(),
    );
    expect(repo.countUnreadForUser).toHaveBeenCalledWith('user-1', {});
    expect(result).toEqual({ data: { unread: 3 } });
  });

  it('marks every authenticated-user notification read', async () => {
    const { service, repo } = build({ recipients: [] });
    const result = await RequestContext.run({ ...CTX, userId: 'user-1' }, () =>
      service.markAllRead(),
    );
    expect(repo.markAllRead).toHaveBeenCalledWith('user-1', expect.any(Date), {});
    expect(result).toEqual({ data: { updated: 2 } });
  });

  it('lists tenant email logs with pagination and filters', async () => {
    const { service, emailLogs } = build({ recipients: [] });
    const result = await RequestContext.run({ ...CTX, userId: 'admin-1' }, () =>
      service.listEmailLogs({
        page: 2,
        pageSize: 10,
        status: EmailNotificationStatus.Sent,
        userId: 'user-1',
      }),
    );
    expect(emailLogs.listForTenant).toHaveBeenCalledWith(
      { limit: 10, offset: 10, status: EmailNotificationStatus.Sent, userId: 'user-1' },
      {},
    );
    expect(result.meta).toEqual({ total: 1, page: 2, pageSize: 10 });
  });
});
