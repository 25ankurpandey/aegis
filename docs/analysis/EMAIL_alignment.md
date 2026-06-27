# EMAIL implementation completeness vs the domain reference

**Area:** Email / notification delivery subsystem — Aegis `apps/notification` vs the domain reference's mail subsystem.

Read-only audit, file:line evidence on both sides.

References / sources:
- **the domain reference** — a production enterprise app; domain reference. AWS SES transport.
- **the email-provider reference** — a nodemailer-based provider reference for the **dev email transport**: an env-driven SMTP transporter (`EmailService.ts`). This is the pattern the Aegis dev provider now follows.
- **Aegis** (`/Users/ankurpandey/Documents/GitHub/aegis`) — `apps/notification/src/**` + `libs/events` + `libs/shared/types/src/notification.shape.ts`.

> Scope rule: external reference codebases are referenced in this doc only (analysis). They must never enter shipped app code.

> Current status (2026-06-27): notification now uses a separate `apps/notification/src/templates/`
> catalog with one TS file per consumed template, each carrying subject, text, and HTML. The renderer
> forwards HTML to the provider, and user-management now exposes the internal contact/audience
> directory that notification fan-out calls. Remaining production-plane gaps are richer branding,
> bounce/complaint ingestion, unsubscribe/suppression workflows, and broader admin APIs.

---

## DECISION (2026-06-26): no SES — adopt the nodemailer pattern for the dev provider

The owner decided **not** to bind AWS SES now. Instead the Aegis email provider was reimplemented to
**reuse the email-provider reference's transport approach** (a `nodemailer`-based `EmailService.ts`):
a single `nodemailer` transporter selected from env, no AWS SDK.

What shipped (`apps/notification/src/services/email-provider.service.ts`, behind the **unchanged**
`EmailProvider` port — additive only):

- **DEV default (no `SMTP_HOST`):** nodemailer's built-in `jsonTransport` — a **no-network** sink that
  fully renders the RFC822 message and returns a real `messageId`, then logs it. Safe for dev/test/CI
  with zero credentials and zero outbound connections; a leaked notification DB row still cannot send.
- **SMTP mode (`SMTP_HOST` set):** a real `nodemailer` SMTP transport pointed at a dev mail catcher
  (MailHog/Mailpit at `localhost:1025`, unauthenticated) or any relay. Auth is attached **only** when
  `SMTP_USER`/`SMTP_PASS` are present, so a local catcher works out of the box.
- Env surface: `SMTP_HOST`, `SMTP_PORT` (default 1025), `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_FROM` / `APP_NAME` (sender identity). **No `AWS_*` / `SES_*` keys, no `aws-sdk`.**
- The idempotent send + ledger contract is intact: `send()` returns the provider `messageId` (with a
  `mail_<uuid>` fallback) and **throws** on transport failure so `EmailSenderService` records `failed`
  and the bus retries / dead-letters. Unit test: `test/services/email-provider.service.spec.ts`
  (dev-sink fallback when unconfigured; SMTP transport used + auth-only-when-supplied when configured;
  throws on transport error).

**Is the email-provider reference good enough?** Its *transport selection* pattern is exactly right for a
dependency-light dev provider and is what we copied. We **improved on it** in three ways rather than
copying verbatim: (1) we add an explicit **no-network dev sink** (`jsonTransport`) for the unconfigured
case — the reference always builds an SMTP transport and would try to reach `smtp.gmail.com:587` with
empty creds, which fails closed in CI; ours fails *open and observable*; (2) we **omit auth when no
credentials are supplied** instead of sending `{ user:'', pass:'' }`, so local catchers work
unauthenticated; (3) we keep the provider a **thin port impl** — templating, the ledger, idempotency,
and status live in `EmailSenderService` / `content-map.ts` / `template-engine.ts`, whereas the
reference's `EmailService` mixes transport + DB logging + per-template send methods + inline HTML in one
~420-line class. The reference's HTML-template catalog and `verifyConnection()` health-check are worth
borrowing *later* (see G5 below) but are not needed for the dev provider.

**SES status:** SES is **NOT used** and is **NOT a requirement**. It remains an *optional* future
**production** binding only — and even then the SMTP path above reaches an SES SMTP endpoint with **no
SDK**; a native `@aws-sdk/client-ses` adapter behind the same port is one possible (not required)
option. The capability-table rows below that reference SES describe the domain reference and an optional
future, not a planned Aegis dependency.

---

## TL;DR verdict

Aegis's email **core mechanics are genuinely strong** and in one dimension (exactly-once delivery) are *better-engineered* than the domain reference: a UNIQUE `idempotency_key` ledger with `FOR UPDATE` row-locking inside an RLS-scoped transaction (`email-sender.service.ts:31-58`, `email-notification-log.repository.ts:22-42`), a typed-total content-map (`content-map.ts:56-79`), a real recipient-resolver fan-out (`recipient-resolver.service.ts`), per-channel preferences (`notification.service.ts:163-170`), and a clean pluggable `EmailProvider` port (`notification.shape.ts:277-280`). The B5 audit's "notifications are never delivered" contract bug is **fixed** in the current code: the consumer now reads tenant from the envelope (`notification.consumer.ts:assertEnvelopeTenant`) and producers carry a `RecipientHint`.

What Aegis **does not yet have**, relative to the domain reference, is the *production email plane*: a real transport (SES) bound behind the port, per-tenant from/reply-to + branding, attachments, bulk/templated send, send-gating (company-level on/off, allow/block domain lists, environment subject-prefixing), a richer terminal-status vocabulary (Disabled/Blocked/NotConfigured), and any bounce/complaint/suppression ingestion. These are deferred, not broken — the port seam means they can be added without reshaping the senders.

---

## Side-by-side capability table

| Capability | the domain reference | aegis | Gap | Severity | Recommendation |
|---|---|---|---|---|---|
| **Transport — SES** | Real `SESClient` with `SendTemplatedEmailCommand` / `SendBulkTemplatedEmailCommand` / `SendEmailCommand` (`EmailNotification.ts:19-26,330-345,500-520,543-555`) | **Not used — by decision (no SES).** `EmailProviderService` now sends via nodemailer (see SMTP row) (`email-provider.service.ts`) | Intentional: SES is NOT bound and NOT required | n/a | SES stays an *optional future production* binding only; if ever wanted, reach it via its SMTP endpoint (no SDK) or an `@aws-sdk/client-ses` adapter behind the unchanged port. |
| **Transport — SMTP / nodemailer** | Not used (SES only) | **Real provider (email-provider reference pattern).** `nodemailer`: no-network `jsonTransport` dev sink by default; real SMTP transport (dev mail catcher / relay) when `SMTP_HOST` set; auth only when `SMTP_USER`/`SMTP_PASS` supplied (`email-provider.service.ts`) | **Aegis is now ahead** (the reference's transport, dependency-light, no AWS) | — | None. Dev/test/CI work with zero config; production sets `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` at a relay. Unit-tested in `test/services/email-provider.service.spec.ts`. |
| **Templating engine** | AWS SES server-side templates; `getSesTemplateMap()` registers ~25 named `Template`s (`template-map.ts:28-58`); HTML+text parts | In-process `TemplateEngine` — `{{var}}` interpolation, named registry, missing-var ⇒ empty (`template-engine.ts:14-58`) | Aegis renders client-side text/plain; no HTML body, no rich template asset | Medium | Keep the in-process engine (it is cleaner and provider-agnostic) but add an HTML body field to `RenderedContent`/`EmailMessage` and a small set of HTML layouts when a real transport lands. |
| **Template catalog size** | ~25 templates incl. invite/welcome/reset/job-lifecycle/payment/reports (`template-map.ts`) | 4 templates: expense-approved, invoice-approved, approval-requested, pay-run-approved (`content-map.ts:18-43`) | Narrow catalog (matches Aegis's narrower event surface) | Low | Grow the catalog as event codes are added; the typed-total `VAR_BUILDERS` map makes a missing builder a compile error — good guardrail. |
| **Idempotency / exactly-once** | `bulkCreate({ ignoreDuplicates:true })` then re-fetch inserted (`email-notification-log/create.ts:9-22`); de-dupe via composite index | UNIQUE `idempotency_key` + `findOrCreateForUpdate` with `LOCK.UPDATE`, short-circuit on `Sent` (`email-sender.service.ts:31-46`, `repo:22-42`) | **Aegis is stronger** | — | None. This is a reference-exceeding strength; document it as the reference pattern. |
| **Delivery ledger / audit of sends** | `email_notification_logs` (transaction_id, user_id, company_id, email, template_name, template_payload, status, error_message) (`email-notification-log.model.ts`) | `email_notification_logs` (tenant_id, user_id, email, template_name, payload, status, idempotency_key, correlation_id, error_message, sent_at) + `listForTenant` compliance view (`email-notification-log.model.ts`, `repo.listForTenant`) | Aegis adds correlation_id + idempotency_key (better traceability); lacks a `transaction_id` batch grouping | Low | Parity+. Consider a batch/group id if bulk send is added. |
| **Terminal status vocabulary** | 6 states: Pending/Success/Failed/**Disabled**/**Blocked**/**NotConfiguredOnAllowed** (`email-notification-log.enum.ts`) | 3 states: Pending/Sent/Failed (`EmailNotificationStatus`) | No distinct "suppressed because policy" vs "failed" status | Medium | Extend `EmailNotificationStatus` with Suppressed/Disabled/Blocked so gated sends are auditable as *intentionally not sent*, not failures. |
| **Send gating — tenant on/off** | `getCompanyEmailSettings` reads `company.email_notification`; disabled ⇒ log `Disabled`, no send (`EmailNotification.ts:38-78,165-190`) | None — channel gate is per-user/per-event preference only (`notification.service.ts:163-170`) | No tenant-level master email switch | Medium | Add a tenant-scoped email-enabled flag (a `notification_preferences` row with `user_id NULL` already models tenant-wide defaults — reuse it for a global email kill). |
| **Send gating — allow/block domain lists** | `isDomainBlacklisted` + `isEmailDomainWhiteListed` from env/store (`EmailNotification.ts:80-140`); explicit bolton block | None | No domain allow/deny enforcement | Medium | Add an allow/deny-domain check in `EmailSenderService` before `provider.send`; log a Suppressed status. Important for non-prod environments. |
| **Per-tenant from / reply-to** | `getEmailFrom()` env-driven, `from` param overrides per call (`email-from.ts`, `EmailNotification.ts:330`); company `receiving_email` override exists (`company.shape.ts`) | `EmailMessage` has `to/subject/body` only — **no `from`/`replyTo`** (`notification.shape.ts:271-275`) | No per-tenant sender identity / reply-to | **High** | Add `from`/`replyTo` to `EmailMessage` + a per-tenant sender-identity resolver (tenant branding row). Required before multi-tenant production send. |
| **Per-tenant branding** | HTML/text footer, logos, social links, address baked in templates (`email-footer.ts`); env subject-prefix `[STAGING]`/`[SANDBOX]` (`EmailNotification.ts:143-165`) | None (plain text body, no footer/branding/prefix) | No branding, no env subject prefix | Medium | Add a tenant-branding model (logo URL, footer, support email) injected at render; add env subject-prefix for non-prod. |
| **Attachments** | `sendEmailMessage(SendEmailRequest)` raw path supports it; SES raw/MIME available; email-attachment tables exist (`migrations 0290/0292/0306`) | None — no attachment field anywhere | No attachment support | Medium | Add `attachments?: {filename, content, contentType}[]` to `EmailMessage` and a SES `SendRawEmail`/MIME path in the real provider. Needed for reports/statements. |
| **Bulk send** | `sendBulkTemplatedNotif` + `sendCustomerBulkEmail` chunks of 50, `SendBulkTemplatedEmailCommand` (`EmailNotification.ts:380-470`, `utils.ts:10-30`) | None — one `provider.send` per recipient via fan-out loop (`notification.service.ts:resolveAndDispatch`) | No batch/bulk transport | Low/Medium | Fan-out-per-recipient is correct for transactional mail and keeps idempotency simple; add a bulk path only for true broadcast (digests/announcements). |
| **Transactional vs bulk separation** | Both exist (templated single + bulk templated) | Only transactional (per-event, per-recipient) | No bulk lane | Low | Acceptable for current event surface; revisit when digest/marketing emails appear. |
| **Localization / i18n** | None found (English-only templates) | None | Parity (neither) | Low | Greenfield opportunity: add a `locale` to recipient/template lookup if/when multi-language is required. Neither reference has it. |
| **Bounce handling** | SES inbound types modeled (`aws-ses/notification.ts`: dkim/dmarc/spf verdicts, bounce action smtpReplyCode/statusCode); receiving pipeline present | None | No bounce ingestion or status feedback | Medium | Add an inbound SES/SNS bounce+complaint webhook → update ledger status + suppression list. Defer until a real transport exists. |
| **Complaint handling** | Same SES inbound plumbing (spam/virus verdicts) | None | No complaint ingestion | Medium | Same as bounce — single SNS subscriber handles both notification types. |
| **Suppression list** | Implicit via domain block/allow + company disable; no dedicated hard-bounce suppression table found | None | No suppression list | Medium | Add a `email_suppressions` table (address, reason, source) checked in `EmailSenderService` before send; fed by bounce/complaint ingestion. |
| **Retry / failure semantics** | SES throw bubbles; relies on SQS redrive→DLQ upstream | Throw bubbles to bus → bounded retry → Kafka `<topic>.dlq` / in-proc DeadLetterSink (`email-sender.service.ts:50-57`) | Parity (Aegis explicit DLQ) | Low | None. Aegis's retry+DLQ contract is documented and explicit. |
| **Channel: SMS** | Not present in mail subsystem | `SmsSenderService` + `SmsProvider` port, reuses the ledger channel-agnostically (`sms-sender.service.ts:10-60`) | **Aegis is ahead** | — | None. SMS provider is a stub like email — same "bind real gateway" follow-up (Twilio/SNS). |
| **Channel: in-app inbox** | `notification` service (list/count/mark-read) (`libs/services/backend/src/notification/*`) | `notifications` table + inbox API (`notification.service.ts:listForUser/markRead`) | Parity | Low | None. |
| **Recipient resolution** | Callers pass explicit recipient lists; helper builds per-recipient content (`CommonEmailNotifationHelper.ts`) | `RecipientResolverService` — hint→set, user/role/group/tenant-admins, degrades to in-app-only on lookup failure (`recipient-resolver.service.ts`) | Aegis generalizes role/group/admin audiences | Low | None; wire the real user-management `/internal/recipients` endpoint. |
| **Preferences (per-channel opt-out)** | Notification-preference UI/redux present | `notification_preferences` (event_type × channel × user, tenant-wide default when user_id NULL, default-ON) (`notification-preference.model.ts`) | Parity+ | Low | None. |
| **Multi-tenant isolation of sends** | `company_id` column + app-layer scoping | `tenant_id` + Postgres **RLS** on the ledger, send runs inside `withTenantTransaction` | **Aegis is stronger** (DB-enforced) | — | None. |

---

## What Aegis already covers well (reference parity or better)

1. **Exactly-once email ledger** — UNIQUE `idempotency_key` + `FOR UPDATE` lock + short-circuit-on-Sent inside an RLS transaction (`email-sender.service.ts:31-58`). The domain reference de-dupes with `bulkCreate(ignoreDuplicates)`; Aegis's locking model is the stronger pattern and the row is never left in `pending` (terminal Sent/Failed always).
2. **Channel-agnostic delivery ledger** — SMS reuses `email_notification_logs` with the address in the generic column and channel encoded into the idempotency key (`sms-sender.service.ts:18-37`), so each channel of one logical event is independently exactly-once.
3. **Typed-total content-map** — `VAR_BUILDERS` is a total map over the `NotificationCode` union; adding a handled code without a builder is a compile-time break (`content-map.ts:50-79`). No silent empty send.
4. **Dependency-free template engine** — named registry, `{{var}}` substitution, missing var ⇒ empty string (never leaks `{{var}}` syntax) (`template-engine.ts`).
5. **Recipient resolver fan-out** — user / role / group / tenant-admins, best-effort with graceful degradation to in-app-only (`recipient-resolver.service.ts`).
6. **Per-channel + tenant-default preferences** with default-ON semantics (`notification.service.ts:163-170`, `notification-preference.model.ts`).
7. **Pluggable provider ports** (`EmailProvider`, `SmsProvider`) holding **no credentials** — a leaked DB row cannot send mail (`notification.shape.ts:265-280`). The real transport is a one-binding change.
8. **Explicit retry + DLQ contract** on send failure, plus a tenant compliance view (`repo.listForTenant`).
9. **DB-enforced tenant isolation (RLS)** on the ledger — stronger than the domain reference's app-layer `company_id` scoping.

---

## Concrete gaps to implement later (prioritized)

### Done
- **G1. Real transport behind `EmailProvider`.** ✅ **DONE (2026-06-26, no SES).** `EmailProviderService` is now a real nodemailer provider following the email-provider reference pattern: no-network `jsonTransport` dev sink by default, real SMTP transport (dev mail catcher / relay) when `SMTP_HOST` is set, auth attached only when credentials are supplied. The port is unchanged (additive); idempotency + ledger + retry/DLQ contract intact; unit-tested. **Production = SMTP relay env vars, no SDK.** SES is an optional future binding only, not required.

### High
- **G2. Per-tenant sender identity (`from`/`replyTo`).** Extend `EmailMessage` with `from`/`replyTo`; add a tenant sender-identity resolver. Mandatory before any multi-tenant production send. Mirror the domain reference's `getEmailFrom()` + per-tenant `receiving_email` override.

### Medium
- **G3. Send-gating layer in `EmailSenderService`** before `provider.send`: tenant email master-switch (model via the existing tenant-wide `notification_preferences` row), allow/deny domain lists (env- or DB-driven), and env subject-prefixing for non-prod. Mirrors the domain reference `EmailNotification.ts:38-140`.
- **G4. Richer terminal status vocabulary.** Add `Suppressed`/`Disabled`/`Blocked` to `EmailNotificationStatus` so a policy-gated send is auditable as *intentionally not sent*, distinct from `Failed`.
- **G5. Per-tenant branding at render** — logo, footer, support email, and an HTML body field on `RenderedContent`/`EmailMessage`. Needed once HTML transport lands.
- **G6. Attachments** — `attachments?: {filename, content, contentType}[]` on `EmailMessage` + SES raw/MIME path. Needed for report/statement delivery.
- **G7. Bounce + complaint ingestion** — an inbound SNS/SES webhook (the domain reference already models the payload in `aws-ses/notification.ts`) that updates ledger status and feeds a suppression list.
- **G8. Suppression list** — `email_suppressions(address, reason, source, created_at)` checked in `EmailSenderService` before send; populated by G7. Tenant-scoped (RLS).

### Low
- **G9. Bulk/broadcast send lane** — only when digest/announcement emails appear; keep transactional fan-out as-is for per-event mail.
- **G10. Localization / i18n** — greenfield (neither reference has it); add a `locale` dimension to template + recipient lookup if multi-language is required.
- **G11. Grow the template catalog** as new `NotificationCode`s are added (welcome/invite/reset analogues), leveraging the compile-time-total `VAR_BUILDERS` guard.

---

## Notes on correctness of the prior B5 audit

The B5 doc (`docs/analysis/B5-notify-async-activity.md`) flagged "notifications are never delivered" because the consumer read `payload.tenantId`. The **current** consumer reads tenant from the envelope (`notification.consumer.ts` → `assertEnvelopeTenant(env)`) and producers carry a `RecipientHint` (`specOf(env.payload)`), so that end-to-end contract bug is **resolved**. The DLQ gap B5 raised is also addressed: `EmailSenderService` bubbles failures to the bus, which dead-letters to `<topic>.dlq` (Kafka) or `DeadLetterSink` (in-proc) per the comment at `email-sender.service.ts:50-57`. This EMAIL audit therefore concerns the *production email plane* (transport, identity, branding, attachments, bounce/suppression), not the delivery wiring.
