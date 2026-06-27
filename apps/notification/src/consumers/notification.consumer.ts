import { Logger, RequestContext } from '@aegis/service-core';
import { NotificationCode } from '@aegis/shared-enums';
import { NotificationShape } from '@aegis/shared-types';
import {
  getBus,
  EventTopic,
  type EventEnvelope,
  type RecipientHint,
  type ExpenseApprovedPayload,
  type ExpenseRejectedPayload,
  type InvoiceApprovedPayload,
  type ApprovalRequestedPayload,
  type PayRunApprovedPayload,
  type NotificationRequestedPayload,
} from '@aegis/events';
import { container } from '../ioc/container';
import { NotificationService } from '../services/notification.service';

/**
 * Anti-ambient-authority guard: the tenant the bus rebuilt into the RequestContext from the envelope
 * MUST match the envelope's own tenant. Tenant authority comes from the ENVELOPE (makeEnvelope stamps
 * it from the producer's RequestContext), never the payload — so notifications are delivered for real
 * tenants instead of throwing on a payload field that never existed.
 */
function assertEnvelopeTenant(env: EventEnvelope): void {
  const ctxTenant = RequestContext.tenantId(); // throws if no scope — fail-closed
  if (!env.tenantId || env.tenantId !== ctxTenant) {
    throw new Error('event tenant does not match propagated context tenant');
  }
}

/**
 * The recipient SPEC carried by an event (W3-09). Today every notification-bound payload carries a
 * `RecipientHint` (a single user + optional inline email), so we build a `user` spec; the resolver
 * then enriches it (userId → email/phone via user-management) and the service fans out per resolved
 * recipient. A producer that needs to address a role/group/tenant-admins audience returns the
 * corresponding spec kind here without any consumer-shape change downstream.
 */
function specOf(payload: RecipientHint): NotificationShape.RecipientSpec {
  return { kind: 'user', userId: payload.recipientUserId, email: payload.recipientEmail };
}

/** Resolve the service lazily so the DI container is fully loaded before first use. */
function service(): NotificationService {
  return container.get(NotificationService);
}

async function onExpenseApproved(env: EventEnvelope<ExpenseApprovedPayload>): Promise<void> {
  assertEnvelopeTenant(env);
  const message: NotificationShape.NotificationMessage = {
    code: NotificationCode.ExpenseApproved,
    reportId: env.payload.reportId,
    approvedBy: env.payload.approvedBy,
    amountMinor: env.payload.amountMinor,
  };
  await service().resolveAndDispatch(message, specOf(env.payload));
}

/**
 * An expense report was REJECTED. Like ExpenseApproved this was PRODUCED by apps/expense (two publish
 * sites) with NO subscriber, so the submitter's rejection notification was silently dropped — the same
 * produced-with-no-consumer class as BUG-0001/BUG-0002. Map to the typed `ExpenseRejected` message and
 * dispatch through the shared resolve-and-fan-out pipeline; tenant comes from the envelope.
 */
async function onExpenseRejected(env: EventEnvelope<ExpenseRejectedPayload>): Promise<void> {
  assertEnvelopeTenant(env);
  const message: NotificationShape.NotificationMessage = {
    code: NotificationCode.ExpenseRejected,
    reportId: env.payload.reportId,
    rejectedBy: env.payload.rejectedBy,
    reason: env.payload.reason,
  };
  await service().resolveAndDispatch(message, specOf(env.payload));
}

async function onInvoiceApproved(env: EventEnvelope<InvoiceApprovedPayload>): Promise<void> {
  assertEnvelopeTenant(env);
  const message: NotificationShape.NotificationMessage = {
    code: NotificationCode.InvoiceApproved,
    invoiceId: env.payload.invoiceId,
    vendorName: env.payload.vendorName,
    amountMinor: env.payload.amountMinor,
    poReference: env.payload.poReference,
  };
  await service().resolveAndDispatch(message, specOf(env.payload));
}

async function onApprovalRequested(env: EventEnvelope<ApprovalRequestedPayload>): Promise<void> {
  assertEnvelopeTenant(env);
  const message: NotificationShape.NotificationMessage = {
    code: NotificationCode.ApprovalRequested,
    approvalId: env.payload.approvalId,
    subjectType: env.payload.subjectType,
    subjectId: env.payload.subjectId,
    requestedBy: env.payload.requestedBy,
  };
  await service().resolveAndDispatch(message, specOf(env.payload));
}

async function onPayRunApproved(env: EventEnvelope<PayRunApprovedPayload>): Promise<void> {
  assertEnvelopeTenant(env);
  const message: NotificationShape.NotificationMessage = {
    code: NotificationCode.PayRunApproved,
    payRunId: env.payload.payRunId,
    approvedBy: env.payload.approvedBy,
  };
  await service().resolveAndDispatch(message, specOf(env.payload));
}

/**
 * BUG-0002: a workflow `notify` rule action PRODUCES `NotificationRequested` with a free-form
 * `template` + `context` (plus a recipient hint), but — before this consumer — NOTHING subscribed,
 * so rule-authored notifications were silently dropped. Map the payload to the generic `RuleNotice`
 * message and dispatch through the SAME resolve-and-fan-out pipeline the typed codes use (recipient
 * hint → resolver → per-recipient create + idempotent email/SMS). Tenant comes from the envelope.
 */
async function onNotificationRequested(
  env: EventEnvelope<NotificationRequestedPayload>,
): Promise<void> {
  assertEnvelopeTenant(env);
  const message: NotificationShape.NotificationMessage = {
    code: NotificationCode.RuleNotice,
    template: env.payload.template,
    context: env.payload.context ?? {},
  };
  await service().resolveAndDispatch(message, specOf(env.payload));
}

/**
 * Register the topic → handler subscriptions. The bus rebuilds the producer's RequestContext
 * (tenantId, correlationId, sourceService) from the envelope before each handler, so consumers run
 * under the same verified context the producer was authorized under (in-process locally; Kafka in
 * the distributed `PROCESS_TYPE=worker` role). Every handler reads tenant from the envelope and the
 * recipient hint from the typed payload (the single shared contract in `@aegis/events`).
 */
export function registerConsumers(): void {
  const bus = getBus();
  bus.subscribe(EventTopic.ExpenseApproved, onExpenseApproved);
  bus.subscribe(EventTopic.ExpenseRejected, onExpenseRejected);
  bus.subscribe(EventTopic.InvoiceApproved, onInvoiceApproved);
  bus.subscribe(EventTopic.ApprovalRequested, onApprovalRequested);
  bus.subscribe(EventTopic.PayRunApproved, onPayRunApproved);
  bus.subscribe(EventTopic.NotificationRequested, onNotificationRequested); // BUG-0002
  Logger.info('notification consumers registered', {
    topics: [
      EventTopic.ExpenseApproved,
      EventTopic.ExpenseRejected,
      EventTopic.InvoiceApproved,
      EventTopic.ApprovalRequested,
      EventTopic.PayRunApproved,
      EventTopic.NotificationRequested,
    ],
  });
}
