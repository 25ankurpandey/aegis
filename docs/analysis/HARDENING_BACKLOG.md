# Aegis Hardening Backlog — Architecture Fidelity & Domain Completeness

> Authoritative consolidation of 10 analysis reports (Track A — service/transport architecture
> fidelity; Track B — domain completeness) plus the prior adversarial runtime-bug review.
> Source reports: `docs/analysis/A3-kafka.md`, `A4-crosscutting.md`, `B1-approvals.md`,
> `B2-expense.md`, `B5-notify-async-activity.md`, `B6-schema.md`.
>
> **Note on reference names:** the two architectural reference codebases are referred to below as
> **REF-A** (the service/transport/bootstrap reference) and **REF-B** (the enterprise back-office
> domain reference). Naming: use only the `@aegis/*` scope and Aegis domain names; do not reference
> external reference codebases or their customers by name anywhere in the repo — including shipped
> application code, commit messages, and the product README.

---

## Part 1 — Direct Answers to the Owner's Questions

### (a) Why do we have a database-context file, and is it better than the reference?

We have a dedicated DB connection/context module (`libs/db/src/connection.ts`,
`libs/db/src/base-model.ts`) because Aegis is an Nx monorepo of independent service apps that all
need one consistent Sequelize bootstrap, one set of base-model options, and one tenant-scoped
transaction helper (`withTenantTransaction`). Centralizing this is **genuinely better** than the
reference's pattern of per-service connection wiring: it gives us a single place for RLS
enforcement, BIGINT-money column defaults, paranoid soft-delete defaults, and the `closeSequelize`
shutdown hook.

**Caveat / where it is currently worse:** the centralization is sound but two operational pieces
are unwired — `closeSequelize()` exists but is never called on `SIGTERM` (no graceful drain), and
the paranoid-soft-delete defaults are not paired with partial unique indexes (see (g)). So the
*file* is better; the *operational completion* of it is not yet.

### (b) Do our models / db-init / bootstrap / createService faithfully follow the reference?

**Mostly yes in shape, with material gaps in operational robustness.** The middleware band, ALS
request context, typed `AppError` map, correlation propagation, helmet, and health endpoints are a
faithful and in several places *cleaner* port (native AsyncLocalStorage, fail-closed UUID header
validation, top-level throw instead of `process.exit` shotgun).

Where we diverge from REF-A:

- **No SIGTERM/SIGINT graceful-shutdown wiring** in `createService`/`startServer` — the reference
  drains in-flight work via a suicide-timer before flipping the health check; we never invoke our
  own `closeSequelize`/`bus.stop()`. **(regression-by-omission)**
- **No boot-time required-config gate** — `Config.require()` only throws on first read, so a
  service can bind the port and accept traffic with missing critical config. The reference
  validates required env *before* connecting. **(missing)**
- **Error envelope leaks raw `err.message`** for unmapped/system errors and echoes Joi
  `context.value`; the reference returns a safe `display_message` and masks validation details.
  **(regression)**
- **No enforced tenant-scoped cache-key helper** — only a comment asks call sites to scope keys; in
  an RLS multi-tenant platform this is a cross-tenant-leak footgun. **(regression)**

### (c) Does the reference connect DB / Kafka / cache on bootstrap, and do we?

**The reference connects the Kafka *producer* on every pod at bootstrap** (`initProducer` defaults
true, orthogonal to the consumer role), and connects DB/cache at boot behind a required-config
gate. **We do not.** This is the single most damaging fidelity break:

- We only call `setBus(new KafkaBus(...))` in the **worker** bootstraps
  (`apps/notification/src/bootstrap.ts:25`, `apps/workflow/src/bootstrap.ts:28`, gated on
  `PROCESS_TYPE=worker`). Verified: those are the **only two** `setBus` call sites in `apps/`.
- The **producer** API pods (expense / invoice / payroll) therefore publish to the default
  in-process bus, which has **zero subscribers in their own process**, so every cross-service
  domain event is silently dropped before it ever reaches Kafka.

This is the root cause that makes (h)'s eventing non-functional end-to-end.

### (d) Is the api-vs-consumer port-exposure deployment split handled?

**Partially — and incorrectly.** The split exists (worker pods register consumers; API pods serve
HTTP), but the producer side of the split is broken: the reference's invariant is *"producer on
every pod, consumer only on worker pods."* We implemented *"bus only on worker pods"*, so API pods
publish into a void. The Compose files run expense/invoice/payroll with `SERVICE_NAME` only and no
`PROCESS_TYPE`, confirming they never get a Kafka bus. The deployment split is recognized but its
load-bearing invariant is violated.

### (e) Do we need Sequelize `sync` + central model registration?

**No `sync` — keep migrations.** We correctly use forward-only migrations
(`apps/cli/src/migrations/0001…0010`) rather than `sequelize.sync()`, which is the right choice for
a production multi-tenant DB (RLS, CHECK constraints, partial indexes cannot be expressed via
`sync`). **Central model registration is worth adding** as a lightweight registry so every aggregate
root opts into shared base-model options (`version: true` once optimistic locking lands, paranoid +
partial-unique pairing) consistently — today those options are applied ad hoc per model and that
inconsistency is exactly what produced the partial-unique-index regression in (g).

### (f) Kafka pattern fidelity

The **transport mechanics** (producer singleton, consumer drain loop, retry-with-backoff) are a
faithful, cleaner port. The **eventing system is non-functional end-to-end** for four reasons,
each independently fatal:

1. Producers never get a `KafkaBus` (see (c)/(d)).
2. The **topic contract is mismatched on every notification topic** — the consumer hard-asserts
   `tenantId`/`recipientUserId`/`recipientEmail` and renamed money/actor fields that **no producer
   emits**; `tenantId` lives on the envelope, not the payload, so `assertContextTenant(payload)`
   reads `undefined` and throws on every event.
3. Workflow subscribes to `record.created` (emitted by nobody) and `record.updated` (emitted only
   by workflow itself); `ApprovalRequested` producer↔consumer payloads are disjoint and not
   awaited.
4. **No DLQ** — retry exhaustion commits the offset and drops the poison message, while
   `email-sender.service.ts:54` comments that a dead-letter policy exists that does not.

### (g) Is our schema comprehensive enough vs the reference?

**In several respects our schema is *better*** — consistent CHECK constraints, idempotency keys the
reference lacks, RLS `FORCE`+`RESTRICTIVE`, BIGINT money, and correct tenant-scoping of unique
constraints. But two must-fix schema defects:

- **CRITICAL:** six paranoid soft-delete tables (`users`, `pay_calendars`, `earning_codes`,
  `deduction_codes`, `expense_categories`, `expense_reports`) plus `tenants.slug` use **plain**
  unique indexes instead of **partial** `WHERE deleted_at IS NULL`. Soft-delete-then-recreate of the
  same natural key throws `23505`. Damning detail: the team applied the correct partial-unique fix
  to `rules` (verified at `0004_workflow.ts:61-65`) and **nowhere else** — direct reference
  infidelity, not a design choice.
- **HIGH:** zero optimistic locking platform-wide; every status-machine aggregate
  (invoices, expense_reports, pay_runs, rules) is open to lost updates under concurrent approvers.
- Plus: `invoice_number` has no dedicated/unique index, and no active-flag/trigram/GIN indexes the
  reference uses on hot paths.

### (h) Did we implement the full approval engine, workflows, rule events, notifications, async, activity tracking, event publish/consume?

**No. This is where the owner's doubt is most justified.**

- **Approval engine: not built.** The advertised "shared multi-level approval engine" is **dead
  stubs** — seven `TableName` enum entries and three approval enums with *no migrations, models, or
  service references anywhere in the repo*. Reality is three siloed single-shot approvals that
  hardcode `level: 1` and never advance a chain. No policies, no thresholds, no manager/hierarchy
  resolution, no approver groups, no delegation, no multilevel.
- **Workflows / rule events: present but disconnected.** The rules-as-data engine exists but never
  auto-fires from real domain writes (its trigger topics have no producers).
- **Notifications: never delivered.** Two ship-blocking defects — broken producer↔consumer
  contract and no recipient resolution — mean zero notifications (in-app or email) are ever sent.
- **Async: lossy.** Retry exhaustion drops messages with no DLQ; the default in-process bus
  swallows handler errors; the transactional outbox is dead code (zero callers).
- **Activity tracking: 2 of 9 services.** Only expense and invoice have activity tables; the
  reference has a polymorphic unified activity table that *drives* notifications — a capability we
  lack entirely.
- **Event publish/consume:** non-functional end-to-end per (f).

**Bright spots worth keeping (genuinely ahead of the reference):** atomic FOR-UPDATE email
idempotency ledger; hash-chained permissions-at-time audit with `verifyChain`; explicit payroll
maker-checker SoD; Postgres RLS on approval rows; BIGINT money + CHECK discipline. All are real
wins — but several are dead-ended behind the broken event contract until Wave 1 lands.

---

## Part 2 — Consolidated Gap Table

| # | Area | Classification | Severity | Effort | Recommendation (short) |
|---|------|----------------|----------|--------|------------------------|
| G1 | Producers never `setBus(KafkaBus)` — API pods publish to in-process bus, events dropped before Kafka | regression | critical | M | Set `KafkaBus` for all roles when Kafka enabled; workers also register consumers + `start()` |
| G2 | Notification consumer payloads omit `tenantId`/`recipientUserId`; producers use wrong keys → guard throws on every event | regression | critical | M | One shared `*Payload` type per topic; producers fill it; assert tenant from envelope, not payload |
| G3 | Notifications never delivered (recipient `{undefined}`, `formatMoney(undefined)=NaN`) — same root as G2 | regression | critical | M | Folded into G2 fix + recipient resolver (G16) |
| G4 | Approval engine declared in enums but never implemented (7 dead table stubs, 3 dead enums) | missing | critical | XL | Build `@aegis/approvals` lib + `0011_approvals.ts`; or minimally delete dead stubs |
| G5 | Soft-delete tables use plain unique indexes, not partial `WHERE deleted_at IS NULL` → 23505 on recreate | regression | critical | M | `0011_partial_unique_indexes.ts` using `0004_workflow.ts:64` as template |
| G6 | Workflow subscribes to `record.created`/`record.updated` with no real producer | regression | high | M | Domains emit `RecordCreated/Updated` OR repoint workflow at concrete topics |
| G7 | `ApprovalRequested` producer↔consumer payloads disjoint + not awaited | regression | high | S | Single shared `ApprovalRequestedPayload`; resolve fields; await publish |
| G8 | No DLQ on retry exhaustion; offset committed → poison dropped; false "dead-letter" comment | missing | high | M | Write failed envelope to `<topic>.dlq`/`dead_letter_events` before commit; fix comment |
| G9 | Default `InProcessBus` swallows handler errors with no retry/DLQ (the only live path) | regression | high | M | Give InProcessBus retry-then-DLQ, or forbid outside single-process dev |
| G10 | Transactional outbox is dead code; producers publish un-awaited, sometimes outside the tx | regression | high | L | Wire `withOutbox` inside the tx, flush post-commit, back with DB outbox table |
| G11 | No SIGTERM/SIGINT graceful shutdown; `closeSequelize`/`bus.stop()` never invoked | missing | high | M | Wire `process.on('SIGTERM'/'SIGINT')` in `createService` to drain + close |
| G12 | `HttpClient.call` has no timeout/retry/breaker (bare fetch) | regression | high | M | `AbortSignal.timeout(ms)` + bounded retry for idempotent verbs |
| G13 | Gateway reverse-proxy has no upstream timeout | missing | high | M | Per-hop timeout (+ optional retry/breaker) in `proxyHandler` |
| G14 | No enforced tenant/scope-aware cache-key helper (cross-tenant leak footgun) | regression | high | S | `CacheAdapter` key helper prefixing `RequestContext.tenantId()`; forbid raw keys |
| G15 | No configurable approval policy per tenant (routing hardcoded as role maps) | missing | high | L | `approval_policies` table + `PolicyResolver.resolve(...)` |
| G16 | No recipient resolution (no manager/team/approver-pool fan-out) | missing | high | L | Recipient resolver deriving from domain; producers stop naming recipients |
| G17 | No per-tenant/per-user notification preferences (only global kill-switch) | missing | high | M | Persist channel/code prefs per tenant+user; consult at dispatch |
| G18 | Activity tracking in 2 of 9 services; no polymorphic activity table; not linked to notifications | missing | high | L | Shared `entity_activities` helper; emit in payroll/user-mgmt/workflow |
| G19 | No optimistic locking / version column on any aggregate | missing | high | L | `0012` adds `version` + `version:true` on mutable aggregate roots |
| G20 | No amount thresholds gating approver levels | missing | high | M | `approver_groups.threshold` + amounts, evaluated with currency conversion |
| G21 | No manager/reporting-manager hierarchy-based approver resolution | missing | high | L | `ApproverResolver` injecting reporting manager from `user_hierarchy` |
| G22 | No approver groups (polymorphic membership) | missing | high | M | `approver_groups` + `approver_group_members`; expand at resolution |
| G23 | Expense `reject` declared everywhere but unreachable (no method/route/perm) | regression | high | M | Add `ExpenseReportReject` perm + route + `rejectReport()` |
| G24 | Expense `reimburse` unimplemented; FINANCE map + branch dead code; FinanceDisburser has no perm | regression | high | M | Add `ExpenseReportReimburse` perm/role/route + `reimburseReport()` |
| G25 | `Config.require` lazy; no boot-time required-config gate | missing | medium | S | Validate required-config set at `init()` before binding port |
| G26 | Error envelope returns raw `err.message` for system errors (info leak) | regression | high | S | Generic `display_message`; raw to logs only |
| G27 | Joi validation details returned verbatim (echoes input `context.value`) | regression | medium | S | Reduce details to `{message,path}` before serializing |
| G28 | `recomputeReportTotal` sums BIGINT across mixed currencies, wrong total pushed to ERP | regression | medium | S | Reject attaching item whose currency ≠ report currency, or convert |
| G29 | ERP push runs post-commit, fire-and-forget, no outbox/retry | regression | medium | M | Drive ERP sync off the emitted `ExpenseApproved` event consumer |
| G30 | Expense submitter `recall` edge declared but no method/route | regression | medium | S | `POST /reports/:id/recall` using existing SUBMITTER edge |
| G31 | Expense comment thread modeled end-to-end but never called (orphaned storage) | missing | medium | S | `addComment()` + route + surface in detail; or remove dead table |
| G32 | `GET /reports/:id` returns bare header — approver can't see items/activity/comments | missing | medium | M | Expand detail or add sub-resource GETs |
| G33 | No delegation/runtime re-assignment/add-approver | missing | medium | M | `Delegation.reassign/addApprover` with job-custom override + audit |
| G34 | Weaker approval audit — no active/superseded vote model | regression | medium | M | Unified vote ledger with `active` supersession + progress log |
| G35 | No parallel-vs-sequential approver distinction | missing | medium | M | Sequential levels + optional parallel reviewer set |
| G36 | `invoice_number` has no dedicated/unique index | missing | medium | S | `addIndex(['tenant_id','vendor_id','invoice_number'])` |
| G37 | No graceful consumer drain (`pauseAll`) before pod restart | missing | medium | S | On SIGTERM pause→drain→`bus.stop()`→exit (folds into G11) |
| G38 | No idempotency/replay-guard middleware (only domain-level) | missing | medium | M | Replay-guard middleware storing first response per key+tenant |
| G39 | No cross-cutting HTTP request/response audit middleware | missing | medium | M | Audit middleware: method/path/status/correlationId, mask auth header |
| G40 | Email-only; inline string templates; provider is a stub | missing | medium | M | Named templates behind a renderer port; add SMS channel port |
| G41 | Audit-chain tail read unlocked + ordered by `created_at` → forks under concurrency | regression | medium | S | Lock tail `FOR UPDATE` / monotonic sequence; order by sequence |
| G42 | No success/pagination envelope helper (success shape hand-rolled) | missing | low | S | Add success/pagination helper to service-core |
| G43 | No CORS policy in core band | missing | low | S | Explicit CORS where browser-facing |
| G44 | No `Logger.alert()` ops channel | missing | low | S | Add alert channel if an alerting sink is desired |
| G45 | Idempotency key folds in `correlationId` → over-collapses distinct events | regression | low | S | Key on code+businessKey+recipient; correlationId = telemetry only |
| G46 | No active-flag/trigram/JSONB-GIN indexes on hot paths | missing | low | S | `(tenant_id, active, …)` now; defer trigram/GIN until search lands |
| G47 | `maxParallelHandles` accepted but not honored (serial drain) | justified | low | S | Document as intentional, or honor if throughput demands |
| G48 | `tenants.slug` global unique conflicts with paranoid soft-delete | regression | low | S | Folded into G5 (partial-unique migration) |
| G49 | `roles` missing partial-unique `(tenant_id,name)` | regression | low | S | Folded into G5 |
| G50 | PEP/authz left to per-service `configure()` (no enforced ordering) | justified | low | S | Keep per-route Casbin; add test/lint asserting PEP before routes |

**Justified divergences (no action / keep):** tenant-scoping of unique constraints; single-level
expense approval as header-level scope; missing billable/reimbursable flag; payroll maker-checker
SoD (keep, carry into shared engine); RLS on approval rows (keep, apply to new tables); atomic
email idempotency ledger (keep); hash-chained audit (keep, harden tail per G41); serial drain (G47).

---

## Part 3 — Prioritized Hardening Backlog (Waves)

Migrations: existing tree is `0001…0010`; **all new migrations start at `0011` and never edit
`0001-0010`.**

### Wave 1 — Correctness Regressions (must land before any event flows or any concurrent write is safe)

| ID | Title | Files | Concrete steps | Parallelizable |
|----|-------|-------|----------------|----------------|
| **W1-01** | Connect producer bus on every pod | `libs/service-core/src/bootstrap/bootstrap.ts`, `apps/*/src/bootstrap.ts`, `libs/events/src/bus.ts`, `docker-compose.all.yml` | In common bootstrap, when Kafka enabled `setBus(new KafkaBus(...))` for ALL roles (lazy producer connect, no consumers unless `start()`); workers additionally `registerConsumers()+bus.start()`; keep InProcessBus as no-broker local default | N (gates W1-02..05) |
| **W1-02** | One shared payload type per topic; producers fill it; tenant from envelope | `libs/shared/types/src/notification.shape.ts`, `libs/events/src/topics.ts`, `apps/{expense,invoice}/src/services/*.service.ts`, `apps/payroll/.../pay-run.service.ts`, `apps/notification/src/consumers/notification.consumer.ts` | Define typed `*Payload` per topic; make `makeEnvelope<T>`/`publish` generically typed (drop `Record<string,unknown>`); producers construct exact shape incl. recipient + renamed money/actor fields; `assertContextTenant` compares envelope tenant; delete impossible `payload.tenantId` check; add producer→consumer contract test per topic | N (after W1-01) |
| **W1-03** | Fix workflow trigger contract | `apps/workflow/src/consumers/index.ts`, `apps/{expense,invoice,payroll}/src/services/*.service.ts`, `apps/workflow/src/engine/actions/builtin.ts` | Either emit `RecordCreated/RecordUpdated` envelopes from domains matching the engine Facts model, OR repoint workflow at concrete domain topics; never leave a subscriber with no producer | Y (with W1-04) |
| **W1-04** | Unify `ApprovalRequested` payload + await publish | `apps/workflow/src/engine/actions/builtin.ts`, `apps/notification/src/consumers/notification.consumer.ts`, `libs/shared/types/src/notification.shape.ts` | Single shared `ApprovalRequestedPayload`; workflow action resolves `subjectType/subjectId/requestedBy/recipientUserId`; `await` the publish | Y (with W1-03) |
| **W1-05** | DLQ on retry exhaustion + truthful comment | `libs/events/src/kafka-bus.ts`, `apps/notification/src/services/email-sender.service.ts` | Before giving up in `handleWithRetry`, `producer.send` failed envelope+error/attempt/topic/offset to `<topic>.dlq` (or `dead_letter_events`), then commit; switch to exponential backoff; make the email-sender comment true | Y |
| **W1-06** | InProcessBus retry-then-DLQ semantics | `libs/events/src/bus.ts` | Give InProcessBus retry-then-DLQ, or forbid outside single-process dev and require durable bus in worker role | Y |
| **W1-07** | Partial unique indexes on soft-delete tables | `apps/cli/src/migrations/0011_partial_unique_indexes.ts` (new) | New forward migration: drop each plain unique index (`users`, `pay_calendars`, `earning_codes`, `deduction_codes`, `expense_categories`, `expense_reports`, `tenants.slug`, `roles`) and recreate `WHERE deleted_at IS NULL` using `0004_workflow.ts:64` as template | Y |
| **W1-08** | Expense reject path | `apps/expense/src/services/expense.service.ts`, `apps/expense/src/controllers/expense-report.controller.ts`, `libs/shared/enums/src/access.enum.ts`, seeders | Add `ExpenseReportReject` permission + `POST /reports/:id/reject` + `rejectReport()` writing `expense_approvals` decision=rejected, `ReportRejected` activity, emit `ExpenseRejected` notification | Y |
| **W1-09** | Expense reimburse path | `apps/expense/src/services/expense.service.ts`, controller, `access.enum.ts`, `apps/cli/src/seeders/0001_system_roles.ts` | Add `ExpenseReportReimburse` permission, grant to finance role, `POST /reports/:id/reimburse` + `reimburseReport()` (activates dead FINANCE map/branch) | Y |
| **W1-10** | Mixed-currency total guard | `apps/expense/src/repositories/expense-report.repository.ts`, `apps/expense/src/services/expense.service.ts` | Reject attaching an item whose currency ≠ report currency (validation/CHECK), or convert; stop silently mis-summing before ERP push | Y |
| **W1-11** | Audit-chain tail concurrency fix | `libs/audit/src/audit-logger.ts` | Lock tail row `FOR UPDATE` (or per-tenant monotonic sequence) before computing `prev_hash`; order by monotonic sequence, not `created_at` | Y |
| **W1-12** | Error envelope info-leak fix | `libs/service-core/src/middleware/error.middleware.ts`, `libs/service-core/src/middleware/validation.middleware.ts` | Return generic `display_message` for System/Database errors; reduce Joi details to `{message,path}`; raw message/details to logs only | Y |

### Wave 2 — Architecture-Fidelity Alignment (bootstrap / db-init / createService / deployment / transport durability)

| ID | Title | Files | Concrete steps | Parallelizable |
|----|-------|-------|----------------|----------------|
| **W2-01** | Graceful shutdown wiring | `libs/service-core/src/bootstrap/bootstrap.ts`, `libs/db/src/connection.ts`, `libs/events/src/kafka-bus.ts` | `process.on('SIGTERM'/'SIGINT')`: stop listener, pause consumers + drain (`pauseAll` intent), `await closeSequelize()` and `bus.stop()`, then exit | Y |
| **W2-02** | Boot-time required-config gate | `libs/service-core/src/config/config.ts`, `createService`/`init` | Validate the required-config set at `init()` before binding the port | Y |
| **W2-03** | HttpClient timeout + retry | `libs/service-core/src/http/http-client.ts` | Add `AbortSignal.timeout(ms)` and bounded retry for idempotent verbs | Y |
| **W2-04** | Gateway proxy upstream timeout | `apps/gateway/src/proxy.ts` | Per-hop timeout (+ optional retry/breaker) in `proxyHandler` | Y |
| **W2-05** | Tenant-scoped cache-key helper | `libs/service-core/src/cache/cache-adapter.ts` | Key helper prefixing `RequestContext.tenantId()`; forbid raw keys in review | Y |
| **W2-06** | Transactional outbox wiring | `libs/events/src/outbox.ts`, `apps/{expense,invoice,payroll}/src/services/*.service.ts`, new outbox migration | Wrap commit+publish in `withOutbox` inside the tx, flush post-commit; back with DB outbox table + relay | N (after W1-01/02) |
| **W2-07** | ERP push via event consumer ✅ | `apps/invoice/src/services/invoice.service.ts`, `apps/payroll/src/services/pay-run.service.ts`, `apps/workflow/src/consumers/connector-sync.consumer.ts` (new) | DONE: the synchronous `ConnectorRegistry.get(...).pushTransaction(...)` in invoice approve + pay-run disburse is gone. Each producer now stages a `ConnectorPushRequested` event in the SAME tx (transactional outbox, W2-06), and the new ERP-sync consumer (workflow worker) performs the push OFF the request path — idempotent via BaseConnector's `idempotencyKey` (redelivery = no-op), retried + dead-lettered by the bus, with the outcome recorded to the audit trail | N (after W2-06) |
| **W2-08** | Optimistic locking | `apps/cli/src/migrations/0012_version_columns.ts` (new), `libs/db/src/base-model.ts`, aggregate models | Add `version INTEGER NOT NULL DEFAULT 0` to mutable aggregate roots (invoices, expense_reports, pay_runs, rules, employees, users, roles); set `version:true`; skip append-only `*_activities` | Y |
| **W2-09** | Central model registry | `libs/db/src/*` | Lightweight registry so every aggregate opts into shared base-model options (paranoid+partial-unique, `version:true`) consistently — prevents recurrence of G5/G19 | Y |
| **W2-10** | invoice_number index | `apps/cli/src/migrations/0013_invoice_number_index.ts` (new) | `addIndex(['tenant_id','vendor_id','invoice_number'])`; decide partial-unique dedup with product | Y |
| **W2-11** | Idempotency-replay middleware | `libs/service-core/src/middleware/*`, `libs/shared/enums/src/http-header-key.enum.ts` | Store first response per `IdempotencyKey`+tenant; replay on repeat | Y |
| **W2-12** | HTTP request/response audit middleware | `libs/service-core/src/middleware/*` | Write method/path/status/correlationId with auth-header masking; exclude health | Y |
| **W2-13** | Success/pagination envelope + CORS + Logger.alert | `libs/service-core/src/*` | Add pagination helper, explicit CORS where browser-facing, `Logger.alert()` channel | Y |
| **W2-14** | PEP-before-routes assertion | test/lint in `libs/service-core` | Keep per-route Casbin; add test asserting PEP runs before routes in every service | Y |

### Wave 3 — Missing Enterprise Domain Capabilities (the shared approval engine + activity + notifications)

| ID | Title | Files | Concrete steps | Parallelizable |
|----|-------|-------|----------------|----------------|
| **W3-01** | Shared `@aegis/approvals` lib + schema | `libs/approvals/*` (new), `apps/cli/src/migrations/0011_approvals.ts` (new — renumber if 0011 taken) | 7 tenant-scoped RLS tables keyed by polymorphic `resource_type`/`resource_id`; `PolicyResolver`, `ApproverResolver`, `ApprovalEngine.getNextApprover/recordDecision/isComplete`, `Delegation`; `approval.*` events; rewrite the three inline `approve()` calls to use it; carry payroll maker-checker SoD as a configurable invariant; apply RLS pattern | N (anchors W3) |
| **W3-02** | Configurable approval policy per tenant | `libs/approvals/*` | `approval_policies` table + `PolicyResolver.resolve(resourceType,resourceId,amount,currency)` with per-tenant default/fallback | N (after W3-01) |
| **W3-03** | Amount thresholds | `libs/approvals/*` | `approver_groups.threshold` + `threshold_amount1/2`, evaluated in PolicyResolver with currency conversion | Y |
| **W3-04** | Approver groups (polymorphic membership) | `libs/approvals/*` | `approver_groups` + `approver_group_members`; expand to candidate user IDs; any member clears the level | Y |
| **W3-05** | Manager/hierarchy approver resolution | `libs/approvals/*`, `user_hierarchy` wiring | `ApproverResolver` injects submitter's reporting manager from `user_hierarchy` when approval-limit config active | N (after W3-01) |
| **W3-06** | Unified vote ledger + active/superseded | `libs/approvals/*` | Vote ledger with `active(bool)` supersession + `approval_progress_log`; port `getActiveApprovals` (splice on rejection) | N (after W3-01) |
| **W3-07** | Delegation / reassign / add-approver | `libs/approvals/*` | `Delegation.reassign/addApprover` with job-custom override semantics + progress/audit writes | Y |
| **W3-08** | Parallel vs sequential | `libs/approvals/*` | Sequential levels + optional parallel reviewer set | Y |
| **W3-09** | Recipient resolver | `apps/notification/src/*` | Derive recipients from domain (submitter, manager, approver pool, team), activity-driven; producers stop naming recipients | N (after W1-02) |
| **W3-10** | Per-tenant/per-user notification prefs | `apps/notification/*`, new migration | Persist channel/code prefs per tenant+user; consult at dispatch; keep global kill-switch as ops override | Y |
| **W3-11** | Shared polymorphic activity table | `libs/*` (new helper), `apps/{payroll,user-management,workflow,reporting}/*`, new migration | `entity_activities` helper `{user_id, tenant_id, activity_details, table_name, table_id}`; emit in payroll/user-mgmt/workflow; drive notifications from activity rows | Y |
| **W3-12** | Template engine + SMS port | `apps/notification/src/services/content-map.ts`, `email-provider.service.ts` | Move templates to named assets behind a renderer port; add an SMS channel port; replace logging stub | Y |
| **W3-13** | Expense detail read + comments + recall | `apps/expense/src/controllers/*`, `apps/expense/src/services/*` | Expand `GET /reports/:id` (items/activities/approvals/comments) or add sub-resource GETs; `addComment()` + route; `POST /reports/:id/recall` | Y |
| **W3-14** | Active-flag list indexes | `apps/cli/src/migrations/0014_active_flag_indexes.ts` (new) | `(tenant_id, active, …)` composite/partial on active-filtered hot lists; defer trigram/GIN until a search feature lands | Y |

### Wave 4 — Documentation

| ID | Title | Files | Concrete steps | Parallelizable |
|----|-------|-------|----------------|----------------|
| **W4-01** | README enterprise-features + feature flags | `README.md`, `docs/*` | Document the shared approval engine, event/outbox/DLQ model, notification prefs, activity tracking, and all feature flags / `PROCESS_TYPE` deployment roles; state which capabilities are flag-gated and their defaults; no external reference or customer names | Y |
| **W4-02** | Deployment topology doc | `docs/*`, `docker-compose.all.yml` comments | Document api-vs-worker split, "producer on every pod / consumer on worker only" invariant, required-config gate, and SIGTERM drain behavior | Y |
| **W4-03** | Honesty pass on dead stubs / comments | `libs/shared/enums/src/table-name.enum.ts`, code comments | Until W3-01 lands, either implement or annotate the approval stubs and the `maxParallelHandles` knob as intentionally-not-wired | Y |

---

## Part 4 — Verdict on the Owner's Doubt

The owner's instinct is **correct on the load-bearing things and wrong on a few details where our
adaptations are genuinely superior.** Honest split:

### Where we are genuinely superior / justified (keep, do not "realign" backward)
- **Centralized DB context + migrations over `sync`** — right call for an RLS, CHECK-constrained,
  partial-index platform.
- **Schema discipline** — consistent CHECK constraints, BIGINT money, idempotency keys, RLS
  `FORCE`+`RESTRICTIVE`, and tenant-scoped unique constraints all exceed the reference.
- **Cleaner service band** — native ALS, fail-closed UUID header validation, typed AppError map,
  centralized correlation propagation, top-level throw over `process.exit`.
- **Real capabilities the reference lacks** — atomic FOR-UPDATE email idempotency ledger,
  hash-chained permissions-at-time audit (`verifyChain`), explicit payroll maker-checker SoD, RLS
  on approval rows.

### Where we regressed and MUST realign
- **The deployment invariant** — producers must connect on every pod. Today API pods publish into
  a void; this alone makes the entire event system non-functional. **(W1-01)**
- **Topic-contract discipline** — one shared, producer-filled payload type per topic; tenant read
  from the envelope. Today every notification throws and is dropped. **(W1-02..04)**
- **Durability** — no DLQ, an error-swallowing default bus, and a dead outbox mean we lose
  messages the reference would redrive. **(W1-05/06, W2-06)**
- **Operational completion of the band** — graceful shutdown, outbound timeouts, config gate,
  tenant-scoped cache keys, and a non-leaky error envelope are all reference behaviors we dropped.
  **(W2-01..05, W1-12)**
- **Schema correctness** — partial unique indexes on soft-delete tables (the team knew the fix and
  applied it once) and optimistic locking. **(W1-07, W2-08)**

### Where the doubt is most justified of all
The **"shared multi-level approval engine" does not exist** — it is enum stubs implying a system
that was never built, fronting three siloed single-shot approvals. This is not a justified scope
cut; it is the central advertised enterprise capability and must be built (`@aegis/approvals`,
Wave 3) — or, at minimum and immediately, the dead stubs deleted so the schema stops lying about
what ships.

**Bottom line:** our *architecture* is the better foundation; our *execution of the reference's
operational and contract discipline* regressed, and our *enterprise domain* (approvals,
notifications, activity, durable async) is materially incomplete. Wave 1 makes runtime correct,
Wave 2 restores fidelity, Wave 3 delivers the missing enterprise surface, Wave 4 tells the truth
about all of it.

---

## Part 5 — Wave 5: Business-Logic Completeness (from `BUSINESS_LOGIC_AUDIT.md`)

Added 2026-06-26 after a per-domain business-logic audit against SPEC + reference domains. These are NEW
material gaps not already covered by Waves 1–4. Wave 3 *built* `@aegis/approvals`; Wave 5 finds it
was never *wired in*, plus runtime-correctness gaps in authz reload, ABAC, payroll tax, dedup
concurrency, and feature-flag caching. **W5-01 is the single most material gap.** Migrations continue
from the existing tree; new migrations start after the highest existing number and never edit prior
ones.

### Wave 5 — Missing Enterprise Business Logic (wire the engine + close correctness/compliance gaps)

| ID | Title | Severity | Effort | Files | Concrete steps |
|----|-------|----------|--------|-------|----------------|
| **W5-01** | Wire the shared approval engine into expense/invoice/payroll + completion consumer | critical | L | `apps/expense/src/services/expense.service.ts` (`approveReport`), `apps/invoice/src/services/invoice.service.ts` (`submit`/`approve`), `apps/payroll/src/services/pay-run.service.ts` (`approve`), new `apps/{expense,invoice,payroll}/src/consumers/approval-completed.consumer.ts`, `libs/approvals/src/index.ts` | Replace each inline single-shot `createApproval(...level:1)` with `ApprovalService.requestApproval(...)` on submit and `ApprovalService.decide(...)` on an approver vote; build a consumer per domain that subscribes to `EventTopic.ApprovalCompleted`, matches `recordType`, and advances the owning record (Approved/Reimbursed/Paid or back to Open on reject). The engine + lib are done (W3-01..08); this is pure integration. |
| **W5-02** | Carry payroll maker-checker into the shared engine as a configurable SoD invariant | high | M | `apps/payroll/src/services/pay-run.service.ts`, `libs/approvals/src/*` (policy `excludeRequester`/SoD) | When W5-01 routes pay-run approval through `@aegis/approvals`, express approver≠creator as the engine's `excludeRequester` SoD policy (keep the hard 403 as defence-in-depth) so SoD is one configurable mechanism, not a payroll-only special case (W3-01 intent). |
| **W5-03** | Casbin policy reload after PAP mutations | critical | M | `libs/access-control/src/enforcer.ts`, `libs/access-control/src/pep.ts`, `apps/user-management/src/services/pap.service.ts` | The enforcer is a build-once singleton (`pep.ts:72`); PAP role/permission CRUD never reaches running pods. Add a Casbin Watcher (pg-notify or redis pub/sub) or call `enforcer.loadPolicy()` + publish an invalidation after every PAP write, so "dynamic runtime roles/permissions" (SPEC §1/§2.2) actually takes effect without a restart. Fail-closed on reload error. |
| **W5-04** | Activate the ABAC / row-level-scope PDP layer | high | M | `apps/*/src/controllers/*.ts`, `apps/user-management/src/services/policy.*`, `libs/access-control/src/pep.ts` | `authorize()` only runs `decide()`/`checkRowScope` when a route supplies `policies:`/`resource:` — no controller passes `policies:` and only expense passes `resource:`. Feed applicable policies (from the PAP/DB) + a resource loader into `authorize` on amount-/owner-/scope-sensitive routes (expense approve, payroll sensitive read, invoice approve), so SPEC §2.3/§2.5 ABAC (amount caps, manager scope, column-mask obligations) is enforced, not dormant. |
| **W5-05** | Payroll tax + pre-tax deductions from `tax_rules` | high | L | `apps/payroll/src/services/pay-run.service.ts` (`computeForEmployee`), `apps/payroll/src/repositories/*`, `tax_rules` model | Tax is hard-coded `0` and `tax_rules` (jurisdiction, effective-dated) is never read; `preTaxDeductions` is a dead const. Resolve effective-dated jurisdiction tax + an `is_pre_tax` flag on deduction codes, compute `taxable_base`/`total_tax` for real so net pay + the ledger are correct (SPEC §0/§5 "jurisdiction-keyed tax config"). |
| **W5-06** | Invoice duplicate-detection concurrency guard | high | M | `apps/invoice/src/services/invoice.service.ts` (`create`), new migration (partial-unique or dedup index), `apps/invoice/src/repositories/invoice.repository.ts` | `findDuplicateCandidate` is read-then-write with a NON-unique index, so two concurrent submits of the same (vendor+number+amount) both insert as non-duplicate → same invoice paid twice. Add a partial-unique index (tenant+vendor+number+amount WHERE not duplicate/deleted) or `SELECT … FOR UPDATE`/serializable so the dedup guard holds under concurrency. |
| **W5-07** | Optimistic locking on pay_runs + invoices | high | S | new `version`-column migration (extend W2-08 coverage), `apps/payroll/src/models/pay-run.model.ts`, `apps/invoice/src/models/invoice.model.ts` | Approve/disburse/approve are read-modify-write guarded only by `assertStatus`; concurrent calls can both pass the status check. Add `version` (Sequelize `version:true`) to `pay_runs` and `invoices` so the second writer fails instead of racing the state transition. |
| **W5-08** | Audit every sensitive-field read (payroll PII) | high | S | `apps/payroll/src/services/employee.service.ts`, `apps/payroll/src/controllers/employee.controller.ts` | SPEC §2.5 mandates "audit every sensitive-field read"; clear PII is currently decrypted with no `AuditLogger.record`. Emit an audit row (actor, tenant, employee id, fields revealed) whenever `canReadSensitive` yields clear salary/bank/national-id. SOC2/GDPR access trail. |
| **W5-09** | Payslip/ledger currency from the payslip, not hard-coded USD | medium | S | `apps/payroll/src/services/pay-run.service.ts` (`create` :68, ledger appends :245) | Payslip shells seed `currency:'USD'` and every ledger entry hard-codes `'USD'` regardless of the payslip currency, mislabelling multi-currency ledgers. Thread the employee/contract currency through and use the payslip currency on ledger entries (or assert single-currency per run). |
| **W5-10** | Cached, context-aware feature-flag helper in service-core | medium | M | `libs/service-core/src/*` (new flag helper), `apps/user-management/src/services/tenant-config.service.ts` (`isFeatureEnabled`, `setFlag` invalidation) | `isFeatureEnabled` opens a fresh tenant transaction + DB hit per call (no cache, no invalidation) — SPEC §11.5 asked for a `@aegis/service-core` flag helper. Add a tenant-scoped cached helper (TTL + pub/sub invalidation on `setFlag`) and gate at least one real feature by a flag to exercise the path. |
| **W5-11** | Mixed-currency expense report total guard | medium | S | `apps/expense/src/services/expense.service.ts` (`attachExpenseToReport`), repository | Confirm/finish W1-10: reject attaching an item whose currency ≠ the report currency (or convert via a rate source) before summing/ERP push, so report totals are never silently mis-added across currencies. |
| **W5-12** | Reconcile dual "approval completed" sources in workflow | low | S | `apps/workflow/src/consumers/index.ts` | Once W5-01 lands, both the inline domain `*Approved` topics AND the engine's `ApprovalCompleted` will mean "approval done". Decide one canonical trigger for `RuleEvent.ApprovalCompleted` so rules don't double-fire or miss the engine path. |
| **W5-13** | Shared polymorphic activity feed across non-expense/invoice domains | low | M | new `entity_activities` helper + migration, `apps/{payroll,user-management,workflow,reporting}/src/services/*` | Extend W3-11: payroll/user-management/workflow write audit but no uniform activity feed. Add the polymorphic `entity_activities` helper and emit from those domains so the "generic append-only activity feed" (SPEC §0) is platform-wide, not expense/invoice-only. |

