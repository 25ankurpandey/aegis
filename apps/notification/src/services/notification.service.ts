import { inject } from 'inversify';
import { ErrUtils, Logger, RequestContext } from '@aegis/service-core';
import { NotificationCode, NotificationChannel } from '@aegis/shared-enums';
import { CommonShape, NotificationShape } from '@aegis/shared-types';
import { PaginationConstants, NotificationConstants } from '@aegis/shared-constants';
import { withTenantTransaction } from '@aegis/db';
import type { Transaction } from 'sequelize';
import { provideSingleton } from '../ioc/container';
import { NotificationRepository } from '../repositories/notification.repository';
import { EmailNotificationLogRepository } from '../repositories/email-notification-log.repository';
import { NotificationPreferenceRepository } from '../repositories/notification-preference.repository';
import { EmailSenderService } from './email-sender.service';
import { SmsSenderService } from './sms-sender.service';
import { RecipientResolverService } from './recipient-resolver.service';
import { render } from './content-map';

/** A derived business key per code — combined with recipient + correlation id for idempotency. */
function businessKey(message: NotificationShape.NotificationMessage): string {
  switch (message.code) {
    case NotificationCode.ExpenseApproved:
      return message.reportId;
    case NotificationCode.ExpenseRejected:
      return message.reportId;
    case NotificationCode.InvoiceApproved:
      return message.invoiceId;
    case NotificationCode.ApprovalRequested:
      return message.approvalId;
    case NotificationCode.PayRunApproved:
      return message.payRunId;
    case NotificationCode.RuleNotice:
      // Rule-authored notice (BUG-0002): the record ref the action attached is the stable key;
      // fall back to the template name when no record ref is present.
      return String(message.context['recordId'] ?? message.template);
  }
}

@provideSingleton(NotificationService)
export class NotificationService {
  constructor(
    @inject(NotificationRepository) private readonly repo: NotificationRepository,
    @inject(EmailNotificationLogRepository)
    private readonly emailLogs: EmailNotificationLogRepository,
    @inject(EmailSenderService) private readonly emailSender: EmailSenderService,
    @inject(SmsSenderService) private readonly smsSender: SmsSenderService,
    @inject(NotificationPreferenceRepository)
    private readonly prefs: NotificationPreferenceRepository,
    @inject(RecipientResolverService) private readonly resolver: RecipientResolverService,
  ) {}

  /**
   * Resolve an event's recipient HINT into the concrete recipient SET (W3-09) and fan out ONE
   * `createAndDispatch` per resolved recipient. Resolution + each dispatch run under the propagated
   * RequestContext; one recipient's failure does not silently swallow the others (the first error
   * bubbles so the bus retries/DLQs the envelope).
   */
  async resolveAndDispatch(
    message: NotificationShape.NotificationMessage,
    spec: NotificationShape.RecipientSpec,
  ): Promise<void> {
    if (!NotificationConstants.isCodeEnabled(message.code)) {
      Logger.info('notification suppressed by per-code kill-switch', { code: message.code });
      return;
    }
    const recipients = await this.resolver.resolve(spec);
    for (const recipient of recipients) {
      await this.createAndDispatch({ message, recipient });
    }
  }

  /**
   * Consume an already-authorized event for ONE resolved recipient: gate (per-code kill-switch) →
   * render → create the in-app row + idempotent email/SMS sends, all inside ONE RLS-scoped
   * transaction. Each outbound channel is additionally gated by the recipient's per-channel
   * preference (W3-10; default-on). Tenant + correlation id come from the RECONSTRUCTED
   * RequestContext — authority is never re-derived here (§6).
   */
  async createAndDispatch(input: NotificationShape.DispatchInput): Promise<void> {
    const { message, recipient } = input;

    if (!NotificationConstants.isCodeEnabled(message.code)) {
      Logger.info('notification suppressed by per-code kill-switch', { code: message.code });
      return;
    }

    const ctx = RequestContext.get();
    const tenantId = ctx.tenantId;
    const correlationId = ctx.correlationId ?? null;
    const content = render(message);
    const baseKey = `${message.code}:${businessKey(message)}:${recipient.userId}:${correlationId ?? ''}`;

    await withTenantTransaction(async (t) => {
      // In-app channel (idempotent insert keyed on tenant+user+code+correlation). Honors the
      // in-app preference; the inbox row is the always-on default but a user may opt it out.
      if (await this.channelEnabled(recipient.userId, message.code, NotificationChannel.InApp, t)) {
        await this.repo.createIfAbsent(
          {
            tenant_id: tenantId,
            user_id: recipient.userId,
            code: message.code,
            message,
            correlation_id: correlationId,
          },
          t,
        );
      }

      // Email channel — only if the recipient has an address AND the channel is not opted out.
      if (
        recipient.email &&
        (await this.channelEnabled(recipient.userId, message.code, NotificationChannel.Email, t))
      ) {
        await this.emailSender.sendIdempotent(
          {
            tenantId,
            userId: recipient.userId,
            email: recipient.email,
            idempotencyKey: `email:${baseKey}`,
            correlationId,
            payload: message,
            content,
          },
          t,
        );
      }

      // SMS channel — only if the recipient has a phone AND the channel is not opted out.
      if (
        recipient.phone &&
        (await this.channelEnabled(recipient.userId, message.code, NotificationChannel.Sms, t))
      ) {
        await this.smsSender.sendIdempotent(
          {
            tenantId,
            userId: recipient.userId,
            phone: recipient.phone,
            idempotencyKey: `sms:${baseKey}`,
            correlationId,
            payload: message,
            content,
          },
          t,
        );
      }
    });
  }

  /** Per-channel preference gate (W3-10): default-on unless an explicit row disables the channel. */
  private channelEnabled(
    userId: string,
    eventType: string,
    channel: NotificationChannel,
    t: Transaction,
  ): Promise<boolean> {
    return this.prefs.isChannelEnabled({ userId, eventType, channel }, t);
  }

  /** Caller's own inbox, paginated. RLS-scoped to tenant; filtered to the caller's user_id. */
  async listForUser(
    query: CommonShape.PageQuery,
  ): Promise<CommonShape.PagedResult<NotificationShape.NotificationRow>> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');

    const page = Math.max(query.page ?? PaginationConstants.DefaultPage, 1);
    const pageSize = Math.min(
      Math.max(query.pageSize ?? PaginationConstants.DefaultPageSize, 1),
      PaginationConstants.MaxPageSize,
    );

    return withTenantTransaction(async (t) => {
      const { rows, count } = await this.repo.listForUser(
        { userId, limit: pageSize, offset: (page - 1) * pageSize },
        t,
      );
      return { data: rows, meta: { total: count, page, pageSize } };
    });
  }

  /** Caller's unread inbox count, used by badges without fetching the full inbox. */
  async unreadCountForUser(): Promise<{ data: NotificationShape.UnreadCount }> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');

    return withTenantTransaction(async (t) => ({
      data: { unread: await this.repo.countUnreadForUser(userId, t) },
    }));
  }

  /** Read one of the caller's own in-app notifications. */
  async getForUser(id: string): Promise<NotificationShape.NotificationRow> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');

    return withTenantTransaction(async (t) => {
      const row = await this.repo.findByIdForUser(id, userId, t);
      if (!row) throw ErrUtils.notFound('Notification not found');
      return row;
    });
  }

  /** Mark one of the caller's own notifications read. Fail-closed (NotFound) if not owned. */
  async markRead(id: string): Promise<NotificationShape.NotificationRow> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');

    return withTenantTransaction(async (t) => {
      const row = await this.repo.markRead(id, userId, t);
      if (!row) throw ErrUtils.notFound('Notification not found');
      return row;
    });
  }

  /** Mark all of the caller's unread notifications as read. */
  async markAllRead(): Promise<{ data: NotificationShape.MarkAllReadResult }> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');

    return withTenantTransaction(async (t) => ({
      data: { updated: await this.repo.markAllRead(userId, new Date(), t) },
    }));
  }

  /** Tenant-scoped email compliance ledger, newest first. */
  async listEmailLogs(
    query: NotificationShape.EmailLogQuery,
  ): Promise<CommonShape.PagedResult<NotificationShape.EmailNotificationLogRow>> {
    const page = Math.max(query.page ?? PaginationConstants.DefaultPage, 1);
    const pageSize = Math.min(
      Math.max(query.pageSize ?? PaginationConstants.DefaultPageSize, 1),
      PaginationConstants.MaxPageSize,
    );

    return withTenantTransaction(async (t) => {
      const { rows, count } = await this.emailLogs.listForTenant(
        {
          limit: pageSize,
          offset: (page - 1) * pageSize,
          status: query.status,
          userId: query.userId,
        },
        t,
      );
      return { data: rows, meta: { total: count, page, pageSize } };
    });
  }
}
