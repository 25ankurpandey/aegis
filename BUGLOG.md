# Aegis — Bug & Issue Log

> Append-only. Scheduled bug-hunting + testing agents and humans record issues here.
> Newest first. When fixed, set Status to `fixed` and add the fixing commit — do not delete.

**Severity:** `critical` · `high` · `medium` · `low` · **Status:** `open` · `in-progress` · `fixed`

| ID       | Area                    | Severity | Status | Summary                                                                                                                                                                                                                                                                    | Fix commit |
| -------- | ----------------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| BUG-0016 | notification/user-management | medium   | fixed  | Notification producers usually carry recipient user ids, but user-management had no internal contact/audience directory for the resolver to call. Fixed with internal s2s contact and recipient endpoints plus validator/service tests. |            |
| BUG-0015 | API/docs                | medium   | fixed | Secondary API drift fixed for the audited surfaces: notification unread/read-all/email-log, reporting run list/export/schedules, payroll own/all payslip reads, and user-management tenant/user/session/policy/invite APIs now have backing models/routes/tests and updated docs. |            |
| BUG-0014 | ERP connectors          | high     | fixed  | Expense still pushed ERP inline after approval and `connector_configs` had no migration/model/API, so the connector architecture was not end-to-end. Fixed by staging expense `ConnectorPushRequested`, adding tenant connector config storage/admin APIs, and DB-backed config resolution. |            |
| BUG-0013 | notification            | medium   | fixed  | Email sender/provider accepted HTML, but all notification templates were inline plain text in code. Fixed with a mail-template catalog carrying text+HTML and renderer support for `RenderedContent.html`.                                          |            |
| BUG-0012 | API/auth guards         | medium   | fixed  | `/auth/me` lacked an `authorize(...)` guard and several core detail reads were missing. Fixed `/auth/me` with a PEP authorization step and added detail APIs for expense items, pay-runs, and notifications.                                          |            |
| BUG-0008 | authz / PAP             | critical | fixed  | Role re-assignment never revokes the old Casbin user-role grouping → user retains prior role's permissions                                                                                                                                                                 |            |
| BUG-0001 | eventing / workflow     | high     | fixed  | `approval.command` (auto_approve / assign_policy rule actions) has no consumer → actions silently no-op                                                                                                                                                                    |            |
| BUG-0002 | eventing / notification | high     | fixed  | `notification.requested` (notify rule action) has no consumer → rule-driven notifications dropped                                                                                                                                                                          |            |
| BUG-0004 | approvals               | high     | fixed  | Parallel-quorum `decide()` lost-update race (READ COMMITTED, no lock) → chain stalls below quorum OR double-emits ApprovalCompleted                                                                                                                                        |            |
| BUG-0005 | approvals / finance     | high     | fixed  | `decide()` commits vote but record status-advance runs in a separate later tx with no recovery → a failure permanently strands the record in APPROVALS                                                                                                                     |            |
| BUG-0010 | invoice                 | high     | fixed  | Duplicate-detection enforcement ignores currency (signature includes it) → legit different-currency invoice marked Duplicate, never paid                                                                                                                                   |            |
| BUG-0006 | approvals               | medium   | fixed  | `reassign()` doesn't check the target already holds a live slot at that level → duplicate pending slot can deadlock a sequential level                                                                                                                                     |            |
| BUG-0003 | events / outbox         | low      | fixed  | `OutboxRelay.start()` uses a fixed setInterval, ignores `drainOnce()` count → not adaptive; caps throughput under backlog (no data loss)                                                                                                                                   |            |
| BUG-0007 | approvals / money       | low      | fixed  | Amount thresholds coerce `Number(bigint)` (invoice/expense) → very large minor-unit amounts can misroute threshold levels                                                                                                                                                  |            |
| BUG-0011 | eventing / workflow     | medium   | fixed  | Wave 6 completed the record-annotation path: workflow `RecordUpdated` writes now persist team/tag/assignee data through finance consumers, backed by teams/tags/record_tags schema, RBAC governance routes, list filters, and rule conditions behind `record.annotations`. |            |
| BUG-0009 | authz / RLS             | low      | fixed  | Roles RLS reuses USING as WITH CHECK → a tenant session could write a global (tenant_id NULL) system role (defense-in-depth gap, not reachable via current app code)                                                                                                       |            |

---

## Details (hunt batch 1 — eventing / approvals / authz-RLS / money; 2-of-2 verified)

### BUG-0016 [medium] Notification recipient directory missing

Notification's resolver already tried to resolve bare `recipientUserId` hints via
`/user-management/internal/users/:id/contact` and role/team/admin audiences via
`/user-management/internal/recipients`, but user-management did not implement those internal
service-to-service routes. Real domain events could therefore create in-app notifications while
skipping email unless the producer happened to include an email. Fix: added internal-auth-protected
contact/audience endpoints, a tenant-RLS directory service, active-user contact repository lookups,
and focused service/validator tests.

### BUG-0015 [medium] API/docs drift fixed

The API audit found that several docs still described endpoints that did not exist in controllers:
notification unread-count/read-all/email-log admin routes, reporting run-list/export/schedule routes,
payroll payslip detail/list reads, and broader user-management tenant/session/policy/invite surfaces.
The first pass added the highest-signal missing detail reads (`GET /expenses/:id`, `GET /pay-runs/:id`,
`GET /notifications/:id`) and fixed `/auth/me` guard composition. This pass added
`/notifications/inbox/unread-count`, `/notifications/inbox/read-all`, `/email-notification-logs`,
report-run list/export and report-schedule CRUD, plus non-sensitive payslip list/detail reads. Follow-up
closed the payroll ownership gap by binding `employees.user_id` to identity users and routing
`payroll.payslip.view.own` through that binding. The remaining user-management drift was closed with
tenant/user read APIs, `sessions` issuance/list/revoke, `policies` CRUD, and `invites` issue/list/revoke,
all backed by tenant-scoped models/migration and focused tests. Remaining IdP work (JWKS/RS256,
refresh tokens, invite-token acceptance, and per-request session introspection) is now tracked as
hardening rather than this API/docs bug.

### BUG-0014 [high] ERP connector architecture incomplete

Expense approval called `ConnectorRegistry.get(...).pushTransaction(...)` directly after commit,
unlike invoice/payroll, and `connector_configs` was only an enum/doc concept. That bypassed the
outbox, connector worker, durable sync-state binding, retry/DLQ, and tenant config resolution. Fix:
expense now stages `ConnectorPushRequested` inside the same transaction; workflow owns
`connector_configs`, admin config/health/sync-state APIs, and a DB-backed `ConnectorConfigStore`;
`BaseConnector` invokes `authenticate(config)` before push.

### BUG-0013 [medium] Notification had no HTML template catalog

The email provider and `RenderedContent` type supported HTML, but `content-map.ts` only defined inline
plain-text templates. Fix: moved the six consumed templates into
`apps/notification/src/templates/mail-templates.ts` with text + HTML bodies and taught
`TemplateEngine.render()` to interpolate and return `html`.

### BUG-0012 [medium] Missing guard/detail reads

The route audit found `/user-management/v1/auth/me` only used `authenticate()` and did not compose the
standard PEP `authorize(...)` guard. It also found missing detail reads for some core records. Fix:
`/auth/me` now composes `authorize(Permission.UserView)`, and the expense/payroll/notification
services expose `GET /expenses/:id`, `GET /pay-runs/:id`, and `GET /notifications/:id`.

### BUG-0008 [critical] Role re-assignment retains old permissions

`apps/user-management/src/services/pap.service.ts:99-105`. `assignRole` does an in-place `UserRoleRepository.assign` then projects the new user→role Casbin grouping, but never removes the PRIOR role's grouping. The old `g(user, oldRole, tenant)` stays in `casbin_rules`, so the user keeps the old role's permissions forever (privilege retention / failed revocation). **Fix:** capture the prior role_id before the update; after commit remove the stale grouping (extend `applyPolicyGrant` with a revoke path) + invalidate.

### BUG-0001 [high] `approval.command` produced, no consumer

`apps/workflow/src/engine/actions/builtin.ts:27-49`. `autoApprove()`/`assignApprovalPolicy()` publish `EventTopic.ApprovalCommand` and return success, but no service subscribes (grep: zero consumers; finance pods are producer-only). Rule auto-approval/policy-binding silently never happens. **Fix:** add an ApprovalCommand consumer (workflow worker → `ApprovalService.decide`/`requestApproval`) registered in the worker role + a produced-topic-has-a-subscriber contract test.

### BUG-0002 [high] `notification.requested` produced, no consumer

`apps/workflow/src/engine/actions/builtin.ts:84-91`. `notify()` publishes `EventTopic.NotificationRequested`; `notification.consumer.ts` subscribes only to ExpenseApproved/InvoiceApproved/ApprovalRequested/PayRunApproved. Rule-authored notifications never delivered. **Fix:** subscribe to NotificationRequested in notification.consumer → map template+context → dispatch; contract test.

### BUG-0004 [high] Parallel-quorum decide race

`libs/approvals/src/approval.service.ts:166-237` + `libs/db/src/transaction.ts:17` (READ COMMITTED, no FOR UPDATE). Two concurrent votes on a `min_approvals=2` parallel level each see only their own slot → both compute <quorum → chain stalls; mirror case double-emits ApprovalCompleted (double ERP push). **Fix:** serialize per-record decide — SERIALIZABLE + 40001 retry, or an advisory/row lock keyed on (record_type, record_id) before read+evaluate.

### BUG-0005 [high] decide→advance split-transaction strands record

`apps/expense/src/services/expense.service.ts:427-467` (+ invoice/payroll mirrors). Vote + ApprovalCompleted commit in the engine tx; the owning record advances in a SEPARATE later tx; no finance service consumes ApprovalCompleted. If the second tx fails, the chain is complete but the record is stuck in APPROVALS forever (retry re-votes → "already voted" conflict). **Fix:** add an idempotent ApprovalCompleted consumer per finance service that calls applyCompletion (drives the advance from the staged event) — also fixes BUG-0001's advance path.

### BUG-0010 [high] Invoice dedup ignores currency

`apps/invoice/src/repositories/invoice.repository.ts:124-128`. Signature is over (vendor+number+amount+currency) but `findDuplicateCandidate` + the partial-unique index omit currency → a legitimate different-currency invoice (same vendor/number/amount) is marked Duplicate and never paid. **Fix:** add currency to `DuplicateCandidateInput` + the WHERE + the partial-unique index so all three agree.

### BUG-0006 [medium] reassign() duplicate slot

`libs/approvals/src/approval.service.ts:245-283`. `reassign()` doesn't check the target already holds a live slot at that level → creates a duplicate pending slot, bypassing the resolver's per-level dedup; a sequential level can deadlock. **Fix:** reject (or merge/supersede) when toApprover already has a live slot at that level.

### BUG-0003 [low] OutboxRelay not adaptive

`libs/events/src/outbox.ts:98-101,196-213`. `tick()` discards `drainOnce()`'s count and uses a fixed `setInterval`, so under a backlog > batchSize it drains one batch per interval (throughput cap + latency; no data loss). **Fix:** adaptive — re-run immediately while a pass drains `batchSize`, fall back to intervalMs when it drains fewer.

### BUG-0007 [low] Amount-threshold `Number(bigint)` precision

`apps/invoice/src/services/invoice.service.ts:375` + `apps/expense/src/services/expense.service.ts:380` → `libs/approvals/src/resolver.ts:248-255`. `amount_minor` (bigint) is coerced via `Number()` before threshold routing; beyond MAX_SAFE_INTEGER it can misroute. **Fix:** carry amountMinor as bigint/string end-to-end through ResolveContext + compare as bigint in thresholdApplies.

### BUG-0009 [low] Roles RLS USING reused as WITH CHECK

`apps/cli/src/migrations/0001_identity.ts:48-56,186`. The roles RLS policy reuses USING as WITH CHECK, so a tenant session could in principle write a global (tenant_id NULL) system role visible to all tenants (defense-in-depth gap; not reachable via current app code). **Fix:** explicit stricter WITH CHECK forbidding NULL-tenant writes under a tenant context.

## How agents append entries

Each entry: next `BUG-NNNN` id, area, severity, status, file:line, expected vs actual, repro, fix-hint. On fix → status `fixed` + commit ref. Group related findings; avoid duplicates.
