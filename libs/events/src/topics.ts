import { randomUUID } from 'node:crypto';
import { RequestContext } from '@aegis/service-core';
import type { PayloadOf } from './payloads';

/** Cross-service domain event topics (the inter-service contract). See docs/06-service-to-service.md. */
export enum EventTopic {
  ExpenseSubmitted = 'expense.submitted',
  ExpenseApproved = 'expense.approved',
  ExpenseRejected = 'expense.rejected',
  InvoiceReceived = 'invoice.received',
  InvoiceApproved = 'invoice.approved',
  /** User-facing: notification fans this out to the approver (carries subject + recipient). */
  ApprovalRequested = 'approval.requested',
  /** Workflow → owning-service command: a rule asked the owner to auto-decide/route an approval. */
  ApprovalCommand = 'approval.command',
  ApprovalCompleted = 'approval.completed',
  PayRunApproved = 'payroll.run.approved',
  PaymentSettled = 'payroll.payment.settled',
  RecordCreated = 'record.created',
  RecordUpdated = 'record.updated',
  NotificationRequested = 'notification.requested',
  ConnectorPushRequested = 'connector.push.requested',
}

/** Self-describing event with the context needed to rebuild a RequestContext on the consumer side. */
export interface EventEnvelope<T = unknown> {
  id: string;
  topic: EventTopic;
  tenantId: string;
  correlationId: string;
  payload: T;
  occurredAt: string;
  sourceService?: string;
}

/**
 * Build an envelope, stamping tenant + correlation id from the active request context. The payload
 * type is pinned to the topic's entry in the shared `EventPayloads` contract, so a producer that
 * emits the wrong shape is a compile-time break (the divergence that severed the contract before).
 */
export function makeEnvelope<T extends EventTopic>(
  topic: T,
  payload: PayloadOf<T>,
): EventEnvelope<PayloadOf<T>> {
  const ctx = RequestContext.tryGet();
  return {
    id: randomUUID(),
    topic,
    tenantId: ctx?.tenantId ?? '',
    correlationId: ctx?.correlationId ?? randomUUID(),
    payload,
    occurredAt: new Date().toISOString(),
    sourceService: ctx?.sourceService,
  };
}
