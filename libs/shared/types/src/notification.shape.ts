import type {
  NotificationCode,
  EmailNotificationStatus,
  EmailSuppressionReason,
  NotificationChannel,
} from '@aegis/shared-enums';

/**
 * Domain contract for the notification service (in-app inbox + idempotent email channel).
 * Service-local DTOs, repository row shapes, repository/service inputs, the typed message union,
 * the email-provider port, the rendered-content shape, and the consumed inter-service event payloads
 * all live here (SPEC §11.2 — no domain types defined inside the service). Controllers, services,
 * repositories, and consumers import these from `@aegis/shared-types`.
 */
export namespace NotificationShape {
  // ---- Typed message (the discriminated union narrowed by NotificationCode) ----

  /**
   * The typed message — a discriminated union narrowed by NotificationCode, so each code carries
   * exactly the data its templates need (a payload-shape change is a compile-time break).
   *
   * Scope guardrails: invoice variants are HEADER-LEVEL (amountMinor + optional poReference; no GL
   * codes, no document-extracted line items — SPEC §10.1). Money is always integer minor units.
   */
  export interface ExpenseApprovedMsg {
    code: NotificationCode.ExpenseApproved;
    reportId: string;
    approvedBy: string;
    amountMinor: number;
  }

  /**
   * An expense report was REJECTED (the produced-with-no-consumer counterpart of ExpenseApproved).
   * Carries the report id, who rejected it, and an optional reason the templates surface.
   */
  export interface ExpenseRejectedMsg {
    code: NotificationCode.ExpenseRejected;
    reportId: string;
    rejectedBy: string;
    reason?: string;
  }

  export interface InvoiceApprovedMsg {
    code: NotificationCode.InvoiceApproved;
    invoiceId: string;
    vendorName: string;
    amountMinor: number; // header-level amount — no line items
    poReference?: string; // optional PO ref; matching is header-level only
  }

  export interface ApprovalRequestedMsg {
    code: NotificationCode.ApprovalRequested;
    approvalId: string;
    /** The record type awaiting approval (e.g. `expense_report`, `invoice`, `pay_run`). */
    subjectType: string;
    subjectId: string;
    requestedBy: string;
  }

  export interface PayRunApprovedMsg {
    code: NotificationCode.PayRunApproved;
    payRunId: string;
    approvedBy: string;
  }

  /**
   * A generic, rule-authored notice (BUG-0002). A workflow `notify` rule action emits
   * `NotificationRequested` with a free-form `template` + `context` map (not one of the typed
   * domain codes), so this variant carries them through to the renderer. `template` selects/labels
   * the notice; `context` (the record ref + ruleId the action attaches) is interpolated and also
   * provides the idempotency business key (its `recordId`, falling back to the template name).
   */
  export interface RuleNoticeMsg {
    code: NotificationCode.RuleNotice;
    template: string;
    context: Record<string, unknown>;
  }

  export type NotificationMessage =
    | ExpenseApprovedMsg
    | ExpenseRejectedMsg
    | InvoiceApprovedMsg
    | ApprovalRequestedMsg
    | PayRunApprovedMsg
    | RuleNoticeMsg;

  /** A resolved recipient + the channels they should receive on. */
  export interface Recipient {
    userId: string;
    email?: string;
    /** Optional phone number for the SMS channel (E.164); absent ⇒ SMS suppressed. */
    phone?: string;
  }

  // ---- Recipient resolution (W3-09 fan-out) ----

  /**
   * The addressing HINT carried on an event — what the producer knew about who to notify. The
   * resolver turns this into the concrete recipient SET (one notification is fanned out per member).
   * A `userId` hint is the common case (carried by `RecipientHint` in `@aegis/events`); the
   * role/group/tenant-admins kinds let a producer address an audience it cannot enumerate itself.
   */
  export type RecipientSpec =
    | { kind: 'user'; userId: string; email?: string; phone?: string }
    | { kind: 'role'; role: string }
    | { kind: 'group'; groupId: string }
    | { kind: 'tenant-admins' };

  /**
   * RecipientResolver port (the cross-service seam, SPEC §1 key-proxy/HttpClient pattern). Given a
   * spec, returns the concrete recipients to fan out to. The default implementation resolves a bare
   * `userId` against user-management (userId → email/phone) via the context-propagating HttpClient,
   * and degrades gracefully (in-app still fans out) when an address cannot be resolved. A consumer
   * fans out ONE `createAndDispatch` per resolved recipient.
   */
  export interface RecipientResolver {
    resolve(spec: RecipientSpec): Promise<Recipient[]>;
  }

  /** Shape of the user-management lookup the default resolver expects (userId → contact info). */
  export interface ResolvedUserContact {
    userId: string;
    email?: string;
    phone?: string;
  }

  // ---- Notification preferences (W3-10) ----

  /**
   * A row of the `notification_preferences` table — per-tenant/per-user channel opt-out. The absence
   * of a row is DEFAULT-ON (the channel is delivered); a row with `enabled = false` suppresses that
   * (event_type, channel) pair for that user. `user_id` NULL = a tenant-wide default for the pair.
   */
  export interface NotificationPreferenceRow {
    id: string;
    tenant_id: string;
    user_id: string | null;
    event_type: string;
    channel: NotificationChannel;
    enabled: boolean;
    created_by: string | null;
    updated_by: string | null;
    created_at: Date;
    updated_at: Date;
  }

  /** Upsert input for a single (tenant, user, event_type, channel) preference. */
  export interface UpsertPreferenceInput {
    tenant_id: string;
    user_id: string | null;
    event_type: string;
    channel: NotificationChannel;
    enabled: boolean;
  }

  /** Lookup key for the consumer's channel gate. */
  export interface PreferenceLookup {
    userId: string;
    eventType: string;
    channel: NotificationChannel;
  }

  // ---- Template engine (W3-12) ----

  /** A named template: subject + text body + optional HTML with `{{var}}` placeholders. */
  export interface MessageTemplate {
    name: string;
    subject: string;
    body: string;
    html?: string;
  }

  /** The variables interpolated into a template (string-rendered before substitution). */
  export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

  // ---- SMS provider port (W3-12, mirrors the email-sender pattern) ----

  /** A templated SMS payload (E.164 destination + already-rendered body). */
  export interface SmsMessage {
    to: string;
    body: string;
  }

  /**
   * SmsProvider port — the pluggable seam for outbound SMS (mirrors `EmailProvider`). Holds NO
   * credentials; a real gateway (Twilio/SNS) plugs in behind this port at composition.
   */
  export interface SmsProvider {
    /** Send a templated SMS; returns a provider reference id. Throws on transient failure. */
    send(message: SmsMessage): Promise<string>;
  }

  /** Args to `SmsSenderService.sendIdempotent` (mirrors the email send input). */
  export interface SendSmsInput {
    tenantId: string;
    userId: string | null;
    phone: string;
    idempotencyKey: string;
    correlationId: string | null;
    payload: unknown;
    content: RenderedContent;
  }

  // ---- Persistence row shapes (what repositories return; `*.get({ plain: true })`) ----

  /** A row of the `notifications` table (the in-app inbox). */
  export interface NotificationRow {
    id: string;
    tenant_id: string;
    user_id: string;
    code: string;
    message: unknown;
    correlation_id: string | null;
    read_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }

  /** A row of the `email_notification_logs` table (the exactly-once email ledger). */
  export interface EmailNotificationLogRow {
    id: string;
    tenant_id: string;
    user_id: string | null;
    email: string;
    template_name: string;
    payload: unknown;
    status: EmailNotificationStatus;
    idempotency_key: string;
    correlation_id: string | null;
    error_message: string | null;
    sent_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }

  // ---- Repository inputs ----

  /** Idempotent insert key for an in-app notification (tenant+user+code+correlation). */
  export interface CreateNotificationInput {
    tenant_id: string;
    user_id: string;
    code: string;
    message: unknown;
    correlation_id: string | null;
  }

  /** Params for the caller's paginated inbox query. */
  export interface ListNotificationsParams {
    userId: string;
    limit: number;
    offset: number;
  }

  /** Params for the tenant-scoped email ledger query. */
  export interface ListEmailLogsParams {
    limit: number;
    offset: number;
    status?: EmailNotificationStatus;
    userId?: string;
  }

  /** HTTP query shape for the email ledger endpoint before pagination is normalized. */
  export interface EmailLogQuery {
    page?: number;
    pageSize?: number;
    status?: EmailNotificationStatus;
    userId?: string;
  }

  /** Compact DTO used by the inbox badge endpoint. */
  export interface UnreadCount {
    unread: number;
  }

  /** Compact DTO used by the bulk mark-read endpoint. */
  export interface MarkAllReadResult {
    updated: number;
  }

  /** Input to `EmailNotificationLogRepository.findOrCreateForUpdate` (the logical-event row). */
  export interface FindOrCreateEmailLogInput {
    tenant_id: string;
    user_id: string | null;
    email: string;
    template_name: string;
    payload: unknown;
    idempotency_key: string;
    correlation_id: string | null;
  }

  // ---- Service inputs (the public method args) ----

  /** Args to `NotificationService.createAndDispatch` (one consumed, already-authorized event). */
  export interface DispatchInput {
    message: NotificationMessage;
    recipient: Recipient;
  }

  /** Args to `EmailSenderService.sendIdempotent`. */
  export interface SendIdempotentInput {
    tenantId: string;
    userId: string | null;
    email: string;
    idempotencyKey: string;
    correlationId: string | null;
    payload: unknown;
    content: RenderedContent;
  }

  // ---- Rendered content (the content-map output) ----

  /** The templated content for one code — email subject/body + the resolved email template id. */
  export interface RenderedContent {
    subject: string; // email subject + in-app title
    body: string; // email/in-app body (templated, text/plain)
    /** Optional rendered text/html body (the nodemailer provider wires it to `mailOptions.html`). */
    html?: string;
    template: string; // email template id resolved per code
    /** Optional attachments to carry through to the provider (reports/statements). */
    attachments?: EmailAttachment[];
  }

  // ---- Email provider port (the key-proxy seam) ----

  /**
   * A single email attachment carried through to the provider (the nodemailer provider maps it
   * straight onto `mailOptions.attachments`). `content` is the raw bytes (a Buffer) or a string;
   * `contentType` is the MIME type (e.g. `application/pdf`). Used for report/statement delivery.
   */
  export interface EmailAttachment {
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }

  /**
   * EmailProvider port — the seam where outbound mail is brokered (key-proxy pattern, SPEC §1).
   * No SMTP/API credential is stored in this service; a real provider plugs in behind this port.
   *
   * `from`/`replyTo` carry the resolved PER-TENANT sender identity (a tenant sends from its own
   * address; absent ⇒ the provider's configured default). `html` and `attachments` are optional rich
   * parts the nodemailer provider already supports (mailOptions html + attachments).
   */
  export interface EmailMessage {
    to: string;
    subject: string;
    body: string;
    /** Resolved per-tenant From (display-name + address); absent ⇒ provider default. */
    from?: string;
    /** Resolved per-tenant Reply-To; absent ⇒ none. */
    replyTo?: string;
    /** Optional text/html body part. */
    html?: string;
    /** Optional attachments (reports/statements). */
    attachments?: EmailAttachment[];
  }

  export interface EmailProvider {
    /** Send a templated message; returns a provider reference id. Throws on transient failure. */
    send(message: EmailMessage): Promise<string>;
  }

  // ---- Per-tenant sender identity (G2) ----

  /**
   * A row of the `email_sender_identities` table — one per tenant. Holds the tenant's outbound
   * From/Reply-To (branding) plus the email master-switch (`email_enabled`). The ABSENCE of a row
   * means: master-switch ON (default-send) and the provider's configured default From is used.
   */
  export interface EmailSenderIdentityRow {
    id: string;
    tenant_id: string;
    /** Display name shown in the From header (e.g. the tenant's brand); optional. */
    from_name: string | null;
    /** Envelope/From address the tenant sends from; NULL ⇒ provider default. */
    from_email: string | null;
    /** Reply-To address; NULL ⇒ none. */
    reply_to: string | null;
    /** Tenant email master-switch — false hard-disables ALL outbound email for the tenant. */
    email_enabled: boolean;
    created_at: Date;
    updated_at: Date;
  }

  /** The resolved sender identity the sender applies to an EmailMessage (null fields ⇒ use defaults). */
  export interface SenderIdentity {
    /** Composed From header (`"Name" <addr>` or bare addr), or null ⇒ provider default From. */
    from: string | null;
    replyTo: string | null;
    /** Tenant email master-switch (true ⇒ sends allowed). */
    emailEnabled: boolean;
  }

  /** Upsert input for a tenant's sender identity / master-switch. */
  export interface UpsertSenderIdentityInput {
    tenant_id: string;
    from_name?: string | null;
    from_email?: string | null;
    reply_to?: string | null;
    email_enabled?: boolean;
  }

  // ---- Suppression list (G8) ----

  /**
   * A row of the `email_suppressions` table — a tenant-scoped address that must NOT be mailed
   * (hard bounce / complaint / unsubscribe). Checked in the sender BEFORE `provider.send`; a hit
   * records the ledger row as `Suppressed`. (Inbound bounce/complaint ingestion is a documented
   * follow-up — the table + pre-send check land now.)
   */
  export interface EmailSuppressionRow {
    id: string;
    tenant_id: string;
    /** Normalized (lower-cased) recipient address. */
    address: string;
    reason: EmailSuppressionReason;
    /** Free-form origin of the entry (e.g. `sns-bounce`, `manual`, `unsubscribe-link`). */
    source: string | null;
    created_at: Date;
  }

  /** Insert input for a suppression-list entry. */
  export interface AddSuppressionInput {
    tenant_id: string;
    address: string;
    reason: EmailSuppressionReason;
    source?: string | null;
  }

  // ---- Consumed inter-service event payloads ----
  //
  // The consumed payload contract is defined ONCE in `@aegis/events` (`EventPayloads`/`PayloadOf`), so
  // producers and the notification consumer share a single source of truth and a shape change is a
  // compile-time break on both ends. Tenant authority is read from the ENVELOPE (not the payload); the
  // payload carries a recipient hint (`RecipientHint`) plus the per-topic business fields. Import the
  // typed payloads (ExpenseApprovedPayload, InvoiceApprovedPayload, ApprovalRequestedPayload,
  // PayRunApprovedPayload, …) from `@aegis/events`.
}
