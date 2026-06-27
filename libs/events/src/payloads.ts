import type { EventTopic } from './topics';

/**
 * The single source-of-truth payload contract: ONE typed payload interface per EventTopic, shared by
 * producers and consumers so a shape change is a compile-time break on both ends. The envelope (see
 * topics.ts) carries `tenantId` + `correlationId` from the producer's RequestContext, so payloads do
 * NOT repeat tenant/correlation — consumers read those from the envelope. Payloads carry only the
 * business facts plus a recipient hint where a consumer needs to address a user.
 *
 * Money is always integer minor units (SPEC §9). `recipientUserId`/`recipientEmail` are hints the
 * notification service addresses; tenant authority always comes from the envelope, never the payload.
 */

/** Recipient hint carried on notification-bound payloads (addressing only; never authority). */
export interface RecipientHint {
  recipientUserId: string;
  recipientEmail?: string;
}

/** expense.submitted — a report was created or moved into the approval flow. */
export interface ExpenseSubmittedPayload {
  reportId: string;
  status: string;
  submitterId: string;
  totalAmount?: number; // integer minor units
  event?: 'created' | 'submitted';
}

/** expense.approved — a report reached APPROVED (notification-bound). */
export interface ExpenseApprovedPayload extends RecipientHint {
  reportId: string;
  status: string;
  approvedBy: string;
  amountMinor: number; // integer minor units
}

/** expense.rejected — a report was rejected (notification-bound). */
export interface ExpenseRejectedPayload extends RecipientHint {
  reportId: string;
  status: string;
  rejectedBy: string;
  reason?: string;
}

/** invoice.received — an invoice was routed into the approval chain. */
export interface InvoiceReceivedPayload {
  invoiceId: string;
  status: string;
  submitterId?: string;
}

/** invoice.approved — an invoice header was approved (notification-bound). */
export interface InvoiceApprovedPayload extends RecipientHint {
  invoiceId: string;
  status: string;
  vendorName: string;
  amountMinor: number; // header-level amount, integer minor units — no line items
  poReference?: string;
}

/**
 * approval.requested — USER-FACING: notify the approver that a subject awaits their decision.
 * Emitted by the shared approval engine (`@aegis/approvals`) when a record's chain is materialised.
 * `subjectType`/`subjectId` are the addressing aliases the notification service renders; the engine
 * also carries the canonical `recordType`/`recordId` (the polymorphic key) + the chain `level`.
 */
export interface ApprovalRequestedPayload extends RecipientHint {
  approvalId: string;
  /** Human-renderable subject type (the record type — e.g. `expense_report`, `invoice`, `pay_run`). */
  subjectType: string;
  subjectId: string;
  requestedBy: string;
  /** Canonical engine key (mirrors subjectType/subjectId). */
  recordType?: string;
  recordId?: string;
  /** The chain level this approver slot sits at (1-based). */
  level?: number;
}

/**
 * approval.command — WORKFLOW → OWNING-SERVICE command: a rule asked the owner to auto-decide/route
 * an approval. NOT user-facing; carries no recipient. The owning service applies it under the
 * propagated context. Distinct from ApprovalRequested to avoid the producer↔consumer collision.
 */
export interface ApprovalCommandPayload {
  recordType: string;
  recordId: string;
  ruleId: string;
  autoApprove?: boolean;
  policyId?: string;
  reason?: string;
}

/**
 * approval.completed — an approval chain resolved. Emitted by the shared approval engine when a
 * record's chain reaches a terminal state, so the owning service advances its record (ERP push for
 * expense/invoice, disburse-eligibility for payroll). `subjectType`/`subjectId` are addressing
 * aliases; `recordType`/`recordId` are the canonical engine key.
 */
export interface ApprovalCompletedPayload {
  approvalId: string;
  /** Human-renderable subject type (the record type — e.g. `expense_report`, `invoice`, `pay_run`). */
  subjectType: string;
  subjectId: string;
  outcome: 'approved' | 'rejected';
  /** Canonical engine key (mirrors subjectType/subjectId). */
  recordType?: string;
  recordId?: string;
  /** The approver whose vote completed the chain (the closing decision). */
  decidedBy?: string;
}

/** payroll.run.approved — a pay run was approved (notification-bound). */
export interface PayRunApprovedPayload extends RecipientHint {
  payRunId: string;
  approvedBy: string;
}

/** payroll.payment.settled — a disbursement settled. */
export interface PaymentSettledPayload {
  payRunId: string;
  paymentId: string;
}

/** record.created — a domain write the rules-as-data engine evaluates (generic facts). */
export interface RecordCreatedPayload {
  recordType: string;
  recordId: string;
  [fact: string]: unknown;
}

/** record.updated — a domain update the engine evaluates (generic facts). */
export interface RecordUpdatedPayload {
  recordType: string;
  recordId: string;
  [fact: string]: unknown;
}

/** notification.requested — a rule asked notification to ping a recipient. */
export interface NotificationRequestedPayload extends RecipientHint {
  template: string;
  context: Record<string, unknown>;
}

/** connector.push.requested — a rule asked the owning service to push a transaction to a connector. */
export interface ConnectorPushRequestedPayload {
  connectorKind: string;
  entity: string;
  idempotencyKey: string;
  recordType: string;
  recordId: string;
  data: Record<string, unknown>;
  ruleId: string;
}

/**
 * The discriminated payload map: `EventPayloads[topic]` is the exact payload type for that topic.
 * `makeEnvelope`, `publish`, and `subscribe` are all typed against this map.
 */
export interface EventPayloads {
  [EventTopic.ExpenseSubmitted]: ExpenseSubmittedPayload;
  [EventTopic.ExpenseApproved]: ExpenseApprovedPayload;
  [EventTopic.ExpenseRejected]: ExpenseRejectedPayload;
  [EventTopic.InvoiceReceived]: InvoiceReceivedPayload;
  [EventTopic.InvoiceApproved]: InvoiceApprovedPayload;
  [EventTopic.ApprovalRequested]: ApprovalRequestedPayload;
  [EventTopic.ApprovalCommand]: ApprovalCommandPayload;
  [EventTopic.ApprovalCompleted]: ApprovalCompletedPayload;
  [EventTopic.PayRunApproved]: PayRunApprovedPayload;
  [EventTopic.PaymentSettled]: PaymentSettledPayload;
  [EventTopic.RecordCreated]: RecordCreatedPayload;
  [EventTopic.RecordUpdated]: RecordUpdatedPayload;
  [EventTopic.NotificationRequested]: NotificationRequestedPayload;
  [EventTopic.ConnectorPushRequested]: ConnectorPushRequestedPayload;
}

/** The payload type for a given topic (used to type producers + consumers from one contract). */
export type PayloadOf<T extends EventTopic> = T extends keyof EventPayloads
  ? EventPayloads[T]
  : unknown;
