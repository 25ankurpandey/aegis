# B5 — Notifications, Async Processing & Activity/Audit Tracking

**Track B (domain-reference completeness) — reference-fidelity & enterprise-completeness audit**

Auditor: principal-engineer review, read-only on both references.
Scope: `apps/notification`, `libs/audit`, `libs/events/kafka-bus.ts`, the `*_activity` tables/models across services, and the producer→consumer event contract that feeds notifications.

References:
- **the domain reference** — a production enterprise app; the domain reference.
- (the architecture reference is referenced only where the kafka-bus is modeled on it.)

---

## TL;DR verdict

The owner's doubt is justified. This area has **two confirmed, ship-blocking defects** plus several genuine enterprise gaps relative to the domain reference:

1. **Notifications are never delivered.** The notification consumer reads a payload shape (`{ tenantId, recipientUserId, recipientEmail, … }`) that **no producer emits**. Every approval producer publishes a different, recipient-less shape. The consumer's first line (`assertContextTenant(env.payload)`) reads `payload.tenantId`, which is always `undefined`, so **every handler throws on every event** → retried 3× → dropped. Zero in-app rows, zero emails. **CONFIRMED.**
2. **Retry-exhaustion silently drops messages — no DLQ.** `KafkaBus.handleWithRetry` returns after N failures and the caller commits the offset anyway. The default `InProcessBus` doesn't even retry — it `catch`es and logs. the domain reference relies on SQS redrive → DLQ for exactly this. **CONFIRMED.**
3. **Activity tracking is applied in 2 of 9 services** (expense, invoice). the domain reference tracks activity as a first-class, *generalized* capability (`job_activities` **and** a polymorphic `unified_table_activities`) and uses it to *drive* notifications. Aegis has no generalized activity log and does not drive notifications from activity.

The lower-level email idempotency machinery in Aegis is actually **better** than the reference's — but it is dead-ended behind the broken contract above.

---

## 1. The notification contract is broken end-to-end (the "confirmed bug", proven)

### What the consumer expects

`apps/notification/src/consumers/notification.consumer.ts:9-18`:
```ts
function assertContextTenant(payload: NotificationShape.ConsumedPayloadBase): void {
  const ctxTenant = RequestContext.tenantId();
  if (!payload.tenantId || payload.tenantId !== ctxTenant) {
    throw new Error('event tenant does not match propagated context tenant');
  }
}
function recipientOf(payload): Recipient {
  return { userId: payload.recipientUserId, email: payload.recipientEmail };
}
```

The contract it consumes — `libs/shared/types/src/notification.shape.ts:174-203`:
```ts
export interface ConsumedPayloadBase {
  tenantId: string;
  recipientUserId: string;
  recipientEmail?: string;
}
export interface ExpenseApprovedPayload extends ConsumedPayloadBase {
  reportId: string; approvedBy: string; amountMinor: number;
}
export interface InvoiceApprovedPayload extends ConsumedPayloadBase {
  invoiceId: string; vendorName: string; amountMinor: number; poReference?: string;
}
```

### What the producers actually emit (none match)

| Topic | Producer | Emitted payload (evidence) | Missing vs contract |
|---|---|---|---|
| `expense.approved` | `apps/expense/src/services/expense.service.ts:249-254` | `{ reportId, status, totalAmount, approverId }` | `tenantId`*, `recipientUserId`, `recipientEmail`; wrong names: `totalAmount`≠`amountMinor`, `approverId`≠`approvedBy` |
| `invoice.approved` | `apps/invoice/src/services/invoice.service.ts:260` | `{ invoiceId, status }` | everything: `tenantId`*, recipient, `vendorName`, `amountMinor` |
| `approval.requested` | `apps/workflow/src/engine/actions/builtin.ts:22-29, 37-43` | `{ ...recordRef, autoApprove/policyId, ruleId, reason }` | `approvalId`, `subjectType`, `subjectId`, `requestedBy`, recipient |
| `payroll.run.approved` | `apps/payroll/src/services/pay-run.service.ts:165-166` | `{ payRunId, approvedBy }` | `tenantId`*, `recipientUserId`, `recipientEmail` |

\* `tenantId` lives on the **envelope** (`EventEnvelope.tenantId`, `libs/events/src/topics.ts:25,38`), not on the payload. So `payload.tenantId` is *structurally never present*. `assertContextTenant` therefore throws `'event tenant does not match propagated context tenant'` on **every** event, for **every** topic, unconditionally.

### Why TypeScript didn't catch it

Producers funnel through `Record<string, unknown>` → `makeEnvelope`:
- `apps/expense/src/services/expense.service.ts:396-397` — `private async publish(topic, payload: Record<string, unknown>)`.
- `apps/invoice/.../invoice.service.ts:246` — `const payload: Record<string, unknown> = {...}`.

`makeEnvelope<T>` (`topics.ts:33`) infers `T` from the loose record, and the consumer casts to the strict `…Payload` type at the subscribe boundary. The two type universes never meet, so the divergence is invisible at compile time and only manifests at runtime.

### Runtime outcome (even if the guard were deleted)

- `recipientOf` → `{ userId: undefined, email: undefined }`. The in-app row insert gets `user_id: undefined`; the email branch (`recipient.email` falsy) is skipped → **no email ever**.
- `content-map.ts:22` interpolates `formatMoney(m.amountMinor)` → `formatMoney(undefined)` → `NaN.NaN`.
- Idempotency key `…:${recipient.userId}:…` (`notification.service.ts:50`) becomes `…:undefined:…` → all distinct events for a tenant collide on `undefined`.

**This is the single most important finding: the notification subsystem delivers nothing.** Everything below about templates/channels/prefs is secondary to the fact that the pipe is severed.

---

## 2. Recipient resolution: entirely absent (the domain reference has it)

the domain reference resolves recipients **inside the pipeline**, not on the producer:
- `libs/topic/consumers/src/job-activity/create.ts:19-24` — a `job_activity` row → `jobActivityToNotificationMessage` → `createNotificationsBackend([user_id], message, company_id)`; the recipient is derived from the job's membership.
- `libs/services/backend/src/notification/create.ts:16-24` — fan-out: `createNotificationsBackend(context, publishMap, userIds[], message, companyId)` creates one notification **per recipient user id** and publishes `notificationCreated` for each.
- `libs/topic/consumers/src/notification/created.ts:21-31` — the `created` consumer loads the user, reads `user.notification.{sms,email}`, and dispatches per channel.

Aegis has **no recipient resolution anywhere** (grep for `resolveRecipient|getUser|membership|approver|manager` in `apps/notification/src` → empty). It assumes producers hand it a fully-resolved single recipient — which they don't. There is no "notify the submitter's manager", no team/role expansion, no fan-out. This is an architectural gap, not just a missing field.

---

## 3. Channels: email-only vs the domain reference's email + SMS + templated library

- the domain reference: SMS **and** Email channels (`notification/created.ts:19-20` constructs both `EmailService` and `SMSService`), plus a library of ~20+ named templated mailers under `libs/services/backend/src/mail/*` dispatched via `sendTemplatedNotif(company_id, email, template_payload, template_name, …)` (`topic/consumers/src/notification/send.ts:33-41`). Templates are named assets keyed by `template_name`.
- Aegis: **email only.** Templates are **inline string literals** in `apps/notification/src/services/content-map.ts:20-43` (`subject/body` built with template-literal concatenation; `template` is just a string id like `'expense-approved'` that nothing actually loads). No template engine, no template store, no localization. The email provider is a logging stub (`email-provider.service.ts:12-20`).

The inline approach is *defensible* for a small, fixed event set (it gives compile-time exhaustiveness via the `RENDERERS` total map, `content-map.ts:19`), but it is a real **capability gap** vs the reference's pluggable template library and would not scale to enterprise notification breadth.

---

## 4. Per-tenant / per-user preferences: only a global kill-switch

- the domain reference: per-user channel prefs persisted on `users.notification` JSON `{ email: true, sms: true }` (`migrations/0040_user_notification_preference.ts`), consulted at dispatch (`created.ts:31`). There is also a `NotificationPreference` UI surface and a team-notification subsystem (`libs/services/backend/src/team-notification`).
- Aegis: the **only** preference mechanism is a global, process-wide per-**code** kill-switch — `NotificationConstants.isCodeEnabled` over a static `DisabledCodes` set (`libs/shared/constants/src/notification.constants.ts:13-14`), checked at `notification.service.ts:41`. There is **no per-tenant** and **no per-user** preference; one tenant cannot mute a code another tenant wants. For a multi-tenant access-control platform this is a notable miss.

---

## 5. Idempotency: Aegis is *better* than the reference (justified improvement)

Credit where due. Aegis's email exactly-once design is more rigorous than the domain reference's:
- `apps/notification/src/repositories/email-notification-log.repository.ts:22-36` — `findOrCreateForUpdate` takes a `FOR UPDATE` row lock on the UNIQUE `idempotency_key`, so concurrent redeliveries serialize and the loser re-reads the winner's terminal status.
- `email-sender.service.ts:38-55` — short-circuits if already `Sent`; on send-failure marks `Failed` (never left `Pending`) and re-throws so the bus applies its policy.

the domain reference's equivalent is `bulkCreate({ ignoreDuplicates: true })` then re-`findAll` (`email-notification-log/create.ts:9-18`) plus a separate `SELECT … FOR UPDATE` at send time (`notification/send.ts:78-95`). Aegis folds create+lock+status into one atomic step inside the RLS transaction. **This is a legitimate, defensible improvement** — provided the contract above is fixed so it ever runs.

Caveat: the idempotency key (`notification.service.ts:50`) includes `correlationId ?? ''`. If two distinct logical events share a correlation id (common when one HTTP request fans out), the key can over-collapse. Minor, secondary to the contract bug.

---

## 6. Async robustness: retry-exhaustion drops messages, no DLQ (confirmed)

### KafkaBus
`libs/events/src/kafka-bus.ts`:
- `handleWithRetry` (236-253): bounded retry (default 3, 1 s delay). On exhaustion it **`return`s** (line 247) — "Give up to avoid head-of-line blocking" — and the **caller commits the offset anyway** (`drain`, 216-220). The message is gone. **No dead-letter topic, no DLQ table, no parking, no alert.** A poison message or a transient outage longer than `3×1s` = permanent silent data loss.
- The retry is **not** exponential backoff — fixed `retryDelayMs` (line 250).
- Comments claim "CommitManager semantics" / "at-least-once," but committing after a *failed* exhausted handler is effectively **at-most-once** for failing messages.

### InProcessBus (the default!)
`libs/events/src/bus.ts:36-42`: the in-process bus — which is the **active default** (`bus.ts:47`, `getBus()`), and the only bus any producer uses today — wraps each handler in `try { await handler } catch { Logger.error(...) }`. **No retry at all, no DLQ, errors swallowed.** Since nothing calls `setBus(new KafkaBus(...))` with a connected broker in the normal run, the *real* delivery path has zero durability.

### Outbox is dead code
`libs/events/src/outbox.ts` defines a transactional `OutboxBuffer`/`withOutbox`, but **no producer uses it** (grep `withOutbox|OutboxBuffer|\.collect(` in `apps` → empty). Producers call `getBus().publish(...)` directly, sometimes **outside** the committing transaction and **un-awaited**:
- `invoice.service.ts:260` — publish after the txn, fine, but un-awaited failures vanish.
- `workflow/.../builtin.ts:22,37,51` — `getBus().publish(...)` is a **floating promise** (not awaited, not returned) inside a synchronous action fn → unhandled rejection on failure, and no ordering guarantee vs the surrounding work.

So the "transactional outbox" the architecture advertises is not wired; a crash between DB-commit and in-memory `publish` loses the event with no recovery.

### vs the reference
the domain reference's durability is **infrastructural**: SQS/SNS Lambda consumers (`apps/background/src/app/consumer/on-publish-event.ts:41-79`). A thrown handler → message not deleted → SQS visibility-timeout redrive → after `maxReceiveCount` → **DLQ** (standard SQS redrive policy). The whole batch runs in one `StartTransaction` (line 67) and only publishes follow-ups *after* commit (`backgroundMessagesForPublish`, 88-91) — a real post-commit outbox. Aegis reproduced the *shape* (queue, back-pressure pause/resume, manual commit) but **dropped the durability guarantee** (no DLQ, no redrive, exhaustion = commit-and-forget).

---

## 7. Activity / audit tracking: strong audit lib, thin & inconsistent activity

### Hash-chained audit lib — good, with one concurrency caveat
`libs/audit/src/audit-logger.ts` is a genuine enterprise asset the domain reference lacks: append-only, per-tenant **hash-chained** audit (`record` 35-51) with a `verifyChain` tamper check (54-67), capturing actor, action, outcome, resource, details, and **permissions-at-time-of-action**. Used in expense, invoice, payroll, and 3 user-management services. This is **better than the domain reference** (which has scattered `*_audit_logs` tables, e.g. `migrations/0170_jobs_net_discrepancy_audit_logs.ts`, with no chaining). **Justified improvement.**

> Caveat (regression-risk within the lib): `record` computes `prev_hash` via `Audit.findOne(order created_at DESC)` (line 37) with no lock and `created_at` as the ordering key. Two concurrent appends in the same tenant can read the same tail → forked chain / duplicate `prev_hash`, and `created_at` ties (same-ms) make ordering non-deterministic. The chain integrity guarantee is weaker than it looks under concurrency. Needs a `FOR UPDATE` on the tail row (or a per-tenant monotonic sequence) to be sound.

### Activity tracking — present in 2 of 9 services, no generalized log
Aegis has per-entity activity only in **expense** (`expense-activity.model.ts`, written via `writeActivity` in `expense.service.ts:230`) and **invoice** (`invoice-activity.model.ts`, `invoice.service.ts:230`). **payroll, user-management, workflow, reporting** — all prime who-did-what surfaces — have **no activity model** (verified by enumerating `apps/*/src` for `*activity*`: only expense + invoice match).

the domain reference treats activity as a **first-class, generalized** capability:
- `job_activities` per-entity timeline (`libs/document/models/src/job-activity.model.ts`) with its own consumers/publishers/redux slice and dedicated indexes (`migrations/0167…`, `0480_add_missing_indexes_for_activity_log.ts`).
- A **polymorphic** `unified_table_activities` (`migrations/0386_unified_table_activities.ts`): `{ user_id, company_id, activity_details JSONB, table_name, table_id }` indexed by `(company_id, table_name, user_id)` — a single who-did-what timeline over **any** entity.
- Activity rows **drive notifications** (`job-activity/create.ts` → `createNotificationsBackend`). In Aegis, activity and notification are unrelated; producers emit events directly and (try to) notify without any activity record.

So Aegis is both **inconsistent** (only 2 domains) and **architecturally narrower** (no generalized activity, no activity→notification linkage) than the reference.

---

## 8. Divergence ledger

| # | What | Class | Sev | Evidence (ours → reference) |
|---|---|---|---|---|
| 1 | Producer payloads don't match consumer contract; `assertContextTenant` always throws; recipient/amount fields absent → **zero notifications delivered** | regression | critical | `expense.service.ts:249`, `invoice.service.ts:260`, `builtin.ts:22/37`, `pay-run.service.ts:166` vs `notification.consumer.ts:9-18` + `notification.shape.ts:174-203` |
| 2 | Retry-exhaustion commits & drops; **no DLQ/redrive/alert**; not exponential | regression | critical | `kafka-bus.ts:236-253, 216-220` vs `on-publish-event.ts:41-79` (SQS redrive→DLQ) |
| 3 | Default `InProcessBus` (the only live path) swallows errors, **no retry, no DLQ** | regression | high | `bus.ts:36-42, 47` |
| 4 | Transactional **outbox is dead code**; producers publish directly, un-awaited, sometimes outside txn | regression | high | `outbox.ts` (no callers) vs `builtin.ts:22` floating promise; reference `on-publish-event.ts:88-91` post-commit publish |
| 5 | **No recipient resolution** (no fan-out, manager/team expansion) | missing | high | `apps/notification/src` (none) vs `job-activity/create.ts:19-24`, `notification/create.ts:16-24` |
| 6 | **No per-tenant/per-user preferences** — only a global per-code kill-switch | missing | high | `notification.constants.ts:13` vs `0040_user_notification_preference.ts` + `created.ts:31` |
| 7 | Activity tracking in **2/9 services**; no generalized `unified_table_activities`; activity doesn't drive notifications | missing | high | expense/invoice activity models only vs `job-activity.model.ts` + `0386_unified_table_activities.ts` |
| 8 | **Email-only**; inline string templates; no template engine/store/i18n; provider is a stub | missing | medium | `content-map.ts:20-43`, `email-provider.service.ts:12-20` vs `mail/*` library + `send.ts:33-41` |
| 9 | Audit chain tail-read is unlocked & `created_at`-ordered → fork/duplicate under concurrency | regression | medium | `audit-logger.ts:37` |
| 10 | Idempotency key folds in `correlationId` → distinct events sharing a correlation can over-collapse | regression | low | `notification.service.ts:50` |
| 11 | Atomic create+lock+status email idempotency (better than the reference's bulkCreate+separate lock) | justified | — | `email-notification-log.repository.ts:22-36` vs `email-notification-log/create.ts:9-18` |
| 12 | Hash-chained, permissions-at-time-of-action audit with `verifyChain` (reference has none) | justified | — | `audit-logger.ts:35-67` |

---

## 9. Recommendations (priority order)

1. **Fix the contract (Div #1) — blocker.** Define one source-of-truth payload type per topic in `shared-types`, make `makeEnvelope<T>` and each producer's `publish` *generically typed* to that `T` (drop `Record<string, unknown>`), and update producers to emit `amountMinor`/`approvedBy`/etc. Move tenant validation to read `RequestContext.tenantId()` from the **envelope** rebuild (it already does this in the bus), not `payload.tenantId`; delete the impossible `assertContextTenant` payload check. Add a producer→consumer **contract test** per topic that round-trips a real producer payload through the consumer. (Effort: M)
2. **Add recipient resolution (Div #5).** Introduce a resolver that derives recipients (submitter, submitter's manager, approver pool, team members) from the domain — ideally driven by activity rows like the reference. Producers should stop trying to name recipients. (Effort: L)
3. **Add a DLQ + redrive (Div #2/#3/#4).** On retry exhaustion, write to a `dead_letter_events` table (or a `.dlq` Kafka topic) **before** committing, with payload + error + attempt count + a replay path; alert. Make `InProcessBus` at least retry-then-DLQ. **Wire the outbox**: have producers `withOutbox` inside the txn and flush post-commit; back it with a DB outbox table + relay so a crash can't lose events. Switch retry to exponential backoff. (Effort: L)
4. **Per-tenant + per-user preferences (Div #6).** Persist channel/code prefs per tenant and per user; consult at dispatch. The global kill-switch can remain as an operational override. (Effort: M)
5. **Generalize + spread activity tracking (Div #7).** Add a shared activity helper (or a polymorphic `entity_activities` table à la `unified_table_activities`) and emit activity in payroll, user-management, and workflow. Consider driving notifications from activity rows. (Effort: L)
6. **Template store + SMS channel (Div #8).** Move templates to named assets behind a renderer port; add an SMS channel port. (Effort: M)
7. **Harden the audit chain (Div #9).** Lock the tail row `FOR UPDATE` (or use a per-tenant monotonic sequence) when computing `prev_hash`; order by a monotonic sequence, not `created_at`. (Effort: S)
8. **Tighten the idempotency key (Div #10).** Key on `code + businessKey + recipient` only; treat `correlationId` as telemetry, not identity. (Effort: S)

---

## 10. Bottom line

The owner is right to doubt this area. The *machinery* in places is excellent (email exactly-once, hash-chained audit) — arguably ahead of the reference — but it sits behind a **severed producer→consumer contract that delivers nothing**, and the async layer **drops messages on failure with no DLQ** because the durable paths (outbox, Kafka DLQ) were modeled in shape but not wired. Activity tracking is a fraction of the reference's: two domains, no generalized log, not linked to notifications. Items #1–#3 are ship-blockers; #4–#7 are the enterprise-completeness gap vs the domain reference.
