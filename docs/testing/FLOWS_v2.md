# Aegis — Wave 1–3 Hardening Test Plan (FLOWS v2)

> **Status:** authoritative, executable test plan for **everything added in Waves 1–3** of the
> hardening backlog (`docs/analysis/HARDENING_BACKLOG.md`). It extends — does not replace — the
> baseline [`flow-catalogue.md`](./flow-catalogue.md) (FLOW-001 … FLOW-093). Where a v1 flow already
> covers a surface (e.g. cross-tenant isolation FLOW-024, audit chain FLOW-093, connector idempotency
> FLOW-032/092) this doc adds the **Wave-specific depth** the baseline only sketched, and assigns new
> `FV2-NNN` ids for the net-new surface (shared approval engine, transactional outbox + relay + DLQ,
> eventing contract split, optimistic locking, idempotency-replay middleware, graceful shutdown drain,
> notification fan-out/preferences/SMS, ERP-via-consumer, gateway upstream timeouts, partial-unique
> recreate, hash-chain concurrency).
>
> **Consistent with** `SPEC.md` (incl. §10), `AGENTS.md`, and the actual shipped code referenced by
> `file:line` throughout. When a flow conflicts with SPEC or with the code, SPEC wins for *intended*
> behavior and the code reference pins *current* behavior — the gap between them is logged to
> `BUGLOG.md`.

---

## How to read FLOWS v2

Each entry keeps the v1 shape (id/title, services, preconditions, steps, DB-state, access-control)
and adds two fields the automation agents key on:

| Field | Meaning |
|---|---|
| **Tier** | **`INT`** = runnable now as a **code-level integration test** with mocked/in-memory infra (in-process `EventBus`, a transactional test DB or a Sequelize mock, a fake `CacheAdapter`, a stub connector / email / SMS provider). **`E2E`** = **Docker-gated live end-to-end** (real Postgres+RLS, real Redis, real Kafka brokers, multiple pods with `PROCESS_TYPE` roles). Some flows have an `INT` slice **and** an `E2E` slice — both are listed. |
| **Wave / backlog** | The backlog item(s) (`W1-…/W2-…/W3-…`) and gap ids (`G…`) the flow verifies. |
| **Code anchors** | The shipped file(s) the assertions are pinned to, so a drift is detectable. |
| **Phases** | Ordered **preconditions → actions → expected → assertions**, written so an automated agent executes them verbatim and emits PASS/FAIL per assertion. |

**Wave-1–3 platform invariants every FV2 flow inherits** (in addition to the v1 platform conventions):

- **Producer on every pod.** `initEventBus()` sets a real bus for *all* roles when Kafka is enabled
  (`libs/events/src/init-bus.ts`); only the **worker** role additionally `registerConsumers()` +
  `bus.start()`. An API pod must never publish into a subscriber-less void (the G1 regression).
- **No dual-write.** Domain events are **staged into `event_outbox` inside the same transaction** as
  the business write via `stageOutboxEvent(env, t)` (`libs/events/src/outbox.ts:40`); a separate
  **relay** (`OutboxRelay`, same file) drains them to the bus **at-least-once** with `FOR UPDATE SKIP
  LOCKED`. There is no post-commit fire-and-forget publish on any state-moving path.
- **Tenant from the envelope, never the payload.** `makeEnvelope` stamps `tenantId`+`correlationId`
  from the producer `RequestContext` (`libs/events/src/topics.ts:41`); every consumer calls
  `assertEnvelopeTenant(env)` (e.g. `apps/notification/src/consumers/notification.consumer.ts:23`)
  comparing the envelope tenant to the rebuilt context tenant — fail-closed if absent or mismatched.
- **At-least-once + idempotent consumers.** Redelivery (relay re-drain, Kafka rebalance) is a no-op:
  notification dedupes on the email/SMS `idempotency_key` UNIQUE ledger; ERP push dedupes on
  `idempotencyKey` in `BaseConnector`; the in-app row is `createIfAbsent`.
- **Retry-then-DLQ, never silent drop.** Both transports dead-letter on retry exhaustion **before**
  advancing the offset/marking handled: Kafka publishes to `<topic>.dlq`
  (`libs/events/src/kafka-bus.ts:280`); the in-process bus calls the `DeadLetterSink`
  (`libs/events/src/bus.ts:19`); the relay parks the row `failed` after `maxAttempts`.
- **Optimistic locking.** Mutable aggregate roots carry a `lock_version` column
  (`libs/db/src/base-model.ts:8`, `LOCK_VERSION_COLUMN`); a stale read-modify-write throws Sequelize
  `OptimisticLockError`, surfaced as **HTTP 409** (`ErrorType.Conflict` → status 409,
  `libs/service-core/src/errors/error-utils.ts:25`).
- **Soft-delete partial uniqueness.** Unique indexes on paranoid tables are `WHERE deleted_at IS
  NULL`, so soft-delete-then-recreate of the same natural key does **not** throw `23505`.

> **IMPORTANT scope note for the agent.** `@aegis/approvals` is **library-complete and unit-tested**
> (`libs/approvals/src/*.spec.ts`) but is **not yet invoked by the domain app services** — `grep` for
> `requestApproval`/`ApprovalService` in `apps/expense|invoice|payroll/src` returns nothing. The
> FV2-1xx engine flows therefore run **at the library level** (`INT`, driving `ApprovalService`
> directly under a transactional test DB) today; the `E2E` slice (submit an expense → engine opens the
> chain → `ApprovalCompleted` advances the report) is **integration-pending** and is marked
> `E2E (pending wiring)`. The agent runs the `INT` slice now and records the wiring gap in `BUGLOG.md`
> rather than reporting an engine failure.

---

## Suite index (FLOWS v2)

| Suite | Flows | Theme | Primary backlog |
|---|---|---|---|
| **K. Shared approval engine** | FV2-100 … FV2-114 | sequential/parallel/threshold/manager/group/SoD/reassign-supersede/idempotent re-request | W3-01..08 |
| **L. Transactional outbox + relay + DLQ** | FV2-120 … FV2-126 | atomic stage, no dual-write, at-least-once redelivery, SKIP-LOCKED, parking, DLQ | W2-06, W1-05/06 |
| **M. Eventing contract** | FV2-130 … FV2-136 | producer-on-every-pod, tenant-from-envelope, ApprovalRequested vs ApprovalCommand split, workflow real triggers | W1-01..04 |
| **N. Optimistic locking** | FV2-140 … FV2-142 | `lock_version` conflict → 409, registry consistency | W2-08/09 |
| **O. Idempotency-replay middleware** | FV2-150 … FV2-153 | first-response replay, tenant-scoped key, 5xx-not-stored, fail-open | W2-11 |
| **P. Graceful shutdown drain** | FV2-160 … FV2-162 | SIGTERM listener-close → LIFO hooks → bus/relay/DB drain under deadline | W2-01, W1/W2 |
| **Q. Notification completeness** | FV2-170 … FV2-178 | recipient fan-out, per-channel prefs, templates, SMS, idempotent ledger | W3-09..12 |
| **R. ERP via consumer** | FV2-180 … FV2-183 | off-request-path push, idempotent redelivery, retry→DLQ, audit outcome | W2-07 |
| **S. Gateway upstream resilience** | FV2-190 … FV2-193 | 504 timeout / 503 refused / 502 unreachable, correlation echo | W2-04 |
| **T. RLS & integrity (Wave depth)** | FV2-200 … FV2-205 | cross-tenant on new tables, hash-chain concurrency, partial-unique recreate | W1-07/11, W2-08 |

---

## Suite K — Shared multi-level approval engine (`@aegis/approvals`)

> All K-flows drive `ApprovalService` (`libs/approvals/src/approval.service.ts`) directly. **Tier
> `INT`** runs under a transactional test DB (or the existing `*.spec.ts` harness) with
> `RequestContext.run({tenantId,…})` establishing scope and a captured in-process bus / outbox stub to
> intercept staged events. Reusable fixtures: tenant `T`, requester `U-req`, approvers `A1`,`A2`,`A3`,
> `manager(U-req)=M`, group `G1={A1,A2}`, policies seeded into `approval_policies`.

### FV2-100 — Single-level sequential approval (happy path)
- **Tier:** INT · **Wave:** W3-01/02/06 · **Anchors:** `approval.service.ts:82,166`; `0012_approvals.ts`
- **Preconditions:** policy for `record_type='expense_report'`, `mode=sequential`, one level
  `[{level:1, source:user, approver_id:A1}]`, `excludeRequester=false`.
- **Actions:** (1) `requestApproval({recordType,recordId,requestedBy:U-req})`. (2) `decide({recordType,
  recordId, approverId:A1, decision:approved})`.
- **Expected:** request returns `chain` with one `pending` slot at level 1; one `ApprovalRequested`
  event staged addressed to `A1`. Decide returns `{completed:true, outcome:'approved'}` and stages one
  `ApprovalCompleted`.
- **Assertions:** `record_approvers` has 1 row status `approved`; `approvals` (vote ledger) has 1
  immutable row `decision=approved`; **exactly one** `ApprovalRequested` + **one** `ApprovalCompleted`
  in the outbox stub (both carry `tenantId=T` on the envelope, empty payload tenant); no second vote
  possible (see FV2-108).

### FV2-101 — Two-level sequential chain advances L1→L2, completes only after last level
- **Tier:** INT · **Wave:** W3-08/06 · **Anchors:** `approval.service.ts:398` (`evaluateCompletion`)
- **Preconditions:** policy `mode=sequential`, levels `[{level:1,user:A1},{level:2,user:A2}]`.
- **Actions:** request → `decide(A1,approved)` → inspect → `decide(A2,approved)`.
- **Expected:** after A1, result `completed:false`; the engine **skips remaining at L1** and notifies
  **L2** (one new `ApprovalRequested` to A2). After A2, `completed:true, approved`.
- **Assertions:** after A1: L1 slot `approved`, L2 slot still `pending`, `ApprovalCompleted` **not yet**
  staged (the record must not advance). After A2: both slots terminal, **one** `ApprovalCompleted`.
  Negative: A2 cannot be decided **before** A1 — calling `decide(A2,…)` first throws `forbidden`
  ("not a pending approver") because L2 is not yet notified/actionable in sequential mode at the engine
  level only when L2 has no pending slot; for the slot model both slots exist as pending, so the
  ordering guarantee is that **completion** never fires until the highest level is satisfied — assert
  `ApprovalCompleted` is staged **only once** and **only after** A2.

### FV2-102 — Parallel level with quorum (`min_approvals`)
- **Tier:** INT · **Wave:** W3-08/04 · **Anchors:** `approval.service.ts:356` (`levelQuorum`), `:368`
- **Preconditions:** policy `mode=parallel`, one level with three user slots `[A1,A2,A3]`,
  `min_approvals:2`.
- **Actions:** request → `decide(A1,approved)` → `decide(A2,approved)`.
- **Expected:** after A1, `completed:false` (quorum 2 not met). After A2, `completed:true, approved`;
  A3's pending slot is skipped (`skipRemaining`).
- **Assertions:** quorum is clamped to slot count (`Math.min(configured, slotCount)` at `:364`) — a
  policy asking `min_approvals:5` against 3 slots still completes at 3. A3 slot status becomes
  `skipped`; A3 can no longer vote.

### FV2-103 — Amount-threshold gates a senior level in / out
- **Tier:** INT · **Wave:** W3-03 · **Anchors:** `resolver.ts:238` (`thresholdApplies`)
- **Preconditions:** policy levels `[{level:1, user:A1}, {level:2, user:A2, amountMinorMin:500000}]`.
- **Actions:** (a) `requestApproval(amountMinor:250000)`; (b) separate record
  `requestApproval(amountMinor:750000)`.
- **Expected:** (a) chain has **only L1** (the ≥5,000.00 senior gate is excluded; level renumbered to
  contiguous 1-based). (b) chain has **two** levels.
- **Assertions:** boundary semantics from `:253` — `amount >= min` includes the boundary; `amount <
  max` excludes the upper boundary. **Unknown amount** with a lower-bound level → that level is
  conservatively **excluded** (`:249`, `return !hasMin`). A `currency` bound that mismatches the
  record currency excludes the level (`:246`).

### FV2-104 — Manager / manager-chain source resolution
- **Tier:** INT · **Wave:** W3-05 · **Anchors:** `resolver.ts:185,189`; `HierarchyRepository`
- **Preconditions:** `approval_hierarchy` rows: `manager(U-req)=M1`, `manager(M1)=M2`. Policy level
  `[{source:manager}]` for one record; `[{source:manager_chain, depth:2}]` for another.
- **Actions:** request both.
- **Expected:** the `manager` level resolves to one slot `M1`; the `manager_chain depth:2` resolves to
  two ordered slots `M1`,`M2`.
- **Assertions:** a requester with **no** manager edge → that level resolves to **zero candidates** and
  the level is dropped (`:147`); if dropping empties the whole chain the engine **auto-completes
  approved** (`approval.service.ts:132`) and stages exactly one `ApprovalCompleted`.

### FV2-105 — Approver-group expansion ("any member clears")
- **Tier:** INT · **Wave:** W3-04 · **Anchors:** `resolver.ts:180`; `ApproverGroupRepository.expandUserMembers`
- **Preconditions:** group `G1={A1,A2}`; policy parallel level `[{source:group, approver_id:G1}]`,
  `min_approvals:1`.
- **Actions:** request → `decide(A1,approved)`.
- **Expected:** chain materializes **two** slots (A1,A2) at one level; A1's single approval clears the
  level (quorum 1); A2 skipped; `completed:true`.
- **Assertions:** de-dup within a level (`:141`) — if A2 is **also** named by a second spec, only one
  slot is created. Group resolving to **zero** members drops the level.

### FV2-106 — Segregation of duties (`excludeRequester`) drops the requester
- **Tier:** INT · **Wave:** W3-01 (SoD hook) · **Anchors:** `resolver.ts:137`; `:51`
- **Preconditions:** policy `excludeRequester:true`, level `[{user:U-req},{user:A1}]`.
- **Actions:** `requestApproval(requestedBy:U-req)`.
- **Expected:** the `U-req` user-typed slot is removed; chain has one slot `A1`.
- **Assertions:** SoD only filters **user-typed** slots equal to `requestedBy` (a role/group slot that
  *contains* the requester is **not** filtered at resolve time — documents the boundary). If exclusion
  empties the chain → auto-complete approved (carries the payroll maker-checker invariant as policy).

### FV2-107 — Rejection short-circuits the chain
- **Tier:** INT · **Wave:** W3-01 · **Anchors:** `approval.service.ts:221` (`skipRemaining` + emit rejected)
- **Preconditions:** two-level sequential chain `[A1],[A2]`.
- **Actions:** `decide(A1, rejected, comment:"missing receipt")`.
- **Expected:** `{completed:true, outcome:'rejected'}`; **all remaining** pending slots (incl. L2)
  flipped to `skipped`; one `ApprovalCompleted` with `outcome:rejected, decidedBy:A1`.
- **Assertions:** the vote ledger records the rejection with its comment; **no further** decide
  succeeds; the higher level is never notified.

### FV2-108 — No double-vote (DB unique + guard)
- **Tier:** INT · **Wave:** W3-06 · **Anchors:** `approval.service.ts:188` (`hasVoted`); `0012_approvals.ts:205` (UNIQUE)
- **Preconditions:** any open chain; A1 already voted at its level.
- **Actions:** `decide(A1, approved)` a second time.
- **Expected:** `conflict` (HTTP 409) — "already acted"/"already voted at this level".
- **Assertions:** the `approvals` UNIQUE `(tenant_id, record_type, record_id, level, approver_id)`
  rejects a duplicate insert even if the in-memory guard is bypassed; vote count stays 1.

### FV2-109 — Reassign supersedes the prior slot, preserves history
- **Tier:** INT · **Wave:** W3-06 · **Anchors:** `approval.service.ts:245`; `0013_approvals_supersede.ts`
- **Preconditions:** open chain with pending slot owned by A1.
- **Actions:** `reassign({fromApproverId:A1, toApproverId:A3, reassignedBy:M})`.
- **Expected:** A1's slot retired (`status=superseded`, `is_active=false`, `superseded_by_id` →
  replacement); a fresh pending slot for A3 at the same level/sequence; one new `ApprovalRequested` to
  A3. The vote ledger is **untouched** (nothing was voted).
- **Assertions:** `getStatus` returns the **live** chain (A3 pending) in `chain` and the **retired** A1
  row in `history`. The partial-unique live index (`WHERE is_active`, `0013:42`) lets the **same**
  approver reappear at the same level after a supersede. Negatives: reassign to the **same** approver →
  409; reassign a **non-pending** slot → 409.

### FV2-110 — Idempotent re-request returns the existing chain (no re-route)
- **Tier:** INT · **Wave:** W3-01 · **Anchors:** `approval.service.ts:88` (`existsForRecord`)
- **Actions:** `requestApproval(R)` twice.
- **Expected:** second call returns the **same** chain unchanged; **no** new slots; **no** duplicate
  `ApprovalRequested`.
- **Assertions:** `record_approvers` row count unchanged after the second call; outbox stub holds the
  events from the first call only.

### FV2-111 — Empty chain auto-completes approved
- **Tier:** INT · **Wave:** W3-01/03 · **Anchors:** `approval.service.ts:132`
- **Preconditions:** policy whose every level is excluded (threshold not met) **or** an unconfigured
  `record_type` (synthesised DEFAULT policy with no levels, `:326`).
- **Actions:** `requestApproval(R)`.
- **Expected:** `chain:[]`; exactly one `ApprovalCompleted outcome:approved`.
- **Assertions:** the engine **never throws** on an unconfigured type (DEFAULT policy is non-null,
  `mode=sequential, min_approvals:1`).

### FV2-112 — Mixed sequential→parallel levels (per-level mode)
- **Tier:** INT · **Wave:** W3-08 · **Anchors:** `approval.service.ts:344` (`levelMode`)
- **Preconditions:** policy `config.levels` where L1 spec `mode:sequential` (single approver) and L2
  spec `mode:parallel, min_approvals:2` over three approvers.
- **Actions:** decide L1 (single), then two of the three L2 approvers.
- **Expected:** L1 advances on its one approval; L2 completes on quorum 2; third L2 slot skipped.
- **Assertions:** `levelMode` reads the per-level spec mode, falling back to the policy mode; the
  completion logic advances only when the decided level's own mode+quorum is satisfied.

### FV2-113 — Tenant isolation of the approval chain (RLS)
- **Tier:** INT (RLS-on test DB) **+ E2E** · **Wave:** W3-01 · **Anchors:** `0012_approvals.ts:222` (FORCE+RESTRICTIVE)
- **Preconditions:** chains for the same `recordId` string under tenants `T-A` and `T-B`.
- **Actions:** under `app.current_tenant=T-A`, `getStatus`/`listForRecord` for the record.
- **Expected:** returns **only** T-A's chain; T-B's identically-keyed rows are invisible.
- **Assertions:** a raw `SELECT * FROM record_approvers WHERE record_id=…` under the app role +
  `app.current_tenant=T-A` returns **0** of T-B's rows (RESTRICTIVE policy). The relay-bypass marker is
  **not** set on this path.

### FV2-114 — `ApprovalCompleted` is staged, not published synchronously (outbox-bound)
- **Tier:** INT · **Wave:** W3-01 × W2-06 · **Anchors:** `approval.service.ts:446,466` (`stageOutboxEvent`)
- **Actions:** complete any chain inside a transaction; force the **transaction to roll back** after
  `decide` returns but before commit (test seam).
- **Expected:** because the event was **staged in the same tx**, a rollback discards **both** the vote
  and the `ApprovalCompleted` row — no event escapes for a decision that didn't commit.
- **Assertions:** post-rollback, `event_outbox` has **no** `ApprovalCompleted` row and the vote ledger
  is empty for the record (atomicity / no dual-write at the engine boundary).

---

## Suite L — Transactional outbox + relay + DLQ

> **Tier `INT`** drives `stageOutboxEvent` / `OutboxRelay` against a transactional test DB and a
> captured `EventBus`. **Tier `E2E`** runs a real producer pod + a `PROCESS_TYPE=relay`/worker draining
> to Kafka with deliberate broker faults.

### FV2-120 — Atomic stage: event commits with the write or not at all
- **Tier:** INT · **Wave:** W2-06 · **Anchors:** `outbox.ts:40`
- **Actions:** (a) business write + `stageOutboxEvent` in one `withTenantTransaction`, **commit**; (b)
  same, but **throw before commit**.
- **Expected:** (a) one `event_outbox` row `status='pending'`, `tenant_id` set, full `envelope` JSON
  captured. (b) **zero** outbox rows and **zero** business rows.
- **Assertions:** no code path publishes to the bus *before* commit; the row carries
  `attempts=0, published_at=NULL`.

### FV2-121 — Relay drains pending → published (at-least-once)
- **Tier:** INT · **Wave:** W2-06 · **Anchors:** `outbox.ts:139` (`drainOnce`)
- **Preconditions:** N pending rows across **two** tenants.
- **Actions:** `relay.drainOnce()`.
- **Expected:** each row published to the bus **once**, then `status='published', published_at` set,
  `last_error=NULL`. The relay sets `app.outbox_relay='on'` (`RlsConstants.OutboxRelayVar`) so it sees
  **every** tenant's rows despite RLS.
- **Assertions:** the published envelope is **byte-identical** to the staged one (correlation id +
  source service intact). Ordering is oldest-first (`ORDER BY created_at ASC`).

### FV2-122 — Crash mid-pass re-drains (at-least-once, no loss)
- **Tier:** INT · **Wave:** W2-06 · **Anchors:** `outbox.ts:162` (publish before mark)
- **Actions:** stub `bus.publish` to resolve but **abort the transaction** before the `UPDATE … SET
  status='published'` commits; re-run `drainOnce()`.
- **Expected:** the row is **still** `pending` after the aborted pass and is **re-published** on the
  next pass — at-least-once, never lost.
- **Assertions:** the downstream consumer is idempotent (envelope id / business idempotency), so the
  re-publish is a no-op at the consumer (cross-check FV2-170/180).

### FV2-123 — Concurrent relays never double-publish (SKIP LOCKED)
- **Tier:** E2E (or INT with two concurrent transactions) · **Wave:** W2-06 · **Anchors:** `outbox.ts:155`
- **Actions:** start two relay instances draining the same backlog concurrently.
- **Expected:** `FOR UPDATE SKIP LOCKED` partitions the pending rows; **each row is published exactly
  once** across both relays.
- **Assertions:** total publish count == pending row count; no row published twice; both relays make
  progress (no deadlock).

### FV2-124 — Retry exhaustion parks the row `failed`
- **Tier:** INT · **Wave:** W2-06 (G8) · **Anchors:** `outbox.ts:170` (catch → attempts/parked)
- **Preconditions:** relay `maxAttempts=3`; `bus.publish` always throws.
- **Actions:** `drainOnce()` repeatedly.
- **Expected:** `attempts` increments 1→2→3; at the 3rd, `status='failed'`, `last_error` set; the row
  stops being drained.
- **Assertions:** a `failed` row is **retained for inspection** (never deleted); a `Logger.error
  OUTBOX_RELAY` with `parked:true` is emitted; the failed row is excluded from the
  `event_outbox_status_created_idx` partial index (`WHERE status='pending'`).

### FV2-125 — Kafka handler DLQ on retry exhaustion (poison message recoverable)
- **Tier:** E2E (Kafka) · **Wave:** W1-05 (G8) · **Anchors:** `kafka-bus.ts:259` (`handleWithRetry`), `:280` (`deadLetter`)
- **Preconditions:** a worker consuming `expense.approved` whose handler always throws;
  `KAFKA_RETRY_MAX=3`.
- **Actions:** publish one event.
- **Expected:** handler retried 3× with **exponential backoff** (`retryDelayMs * 2^(attempt-1)`); then
  the envelope is published to `expense.approved.dlq` as a `DeadLetterRecord`
  (`{originalTopic,partition,offset,attempts,error,failedAt,envelope}`) **before** the offset is
  committed; then the offset advances (no head-of-line block).
- **Assertions:** the DLQ message carries headers `originalTopic/error/attempts/correlationId/tenantId`;
  the main topic's consumer is **not** wedged (subsequent good messages process). If the DLQ publish
  itself fails, a `KAFKA_DLQ_SEND` alert is logged and the offset still advances (documented trade-off).

### FV2-126 — In-process bus retry-then-DLQ (single-process dev parity)
- **Tier:** INT · **Wave:** W1-06 (G9) · **Anchors:** `bus.ts:19` (`DeadLetterSink`), `:46`
- **Actions:** subscribe a handler that throws; publish; override `setDeadLetterSink` with a capture.
- **Expected:** the in-process bus retries with backoff then routes the envelope to the
  `DeadLetterSink` (default logs `EVENT_DLQ`) — it does **not** silently swallow the error.
- **Assertions:** the sink receives `(env, {topic, error, attempts})`; with a durable sink wired
  (e.g. a `dead_letter_events` table) the envelope is recoverable.

---

## Suite M — Eventing contract

### FV2-130 — Producer connects on every pod (API pods publish to a real bus)
- **Tier:** E2E · **Wave:** W1-01 (G1) · **Anchors:** `libs/events/src/init-bus.ts`; `docker-compose.all.yml`
- **Preconditions:** Kafka enabled (`KAFKA_BROKERS` set). Bring up an **API** pod (no `PROCESS_TYPE`)
  and a **worker** pod.
- **Actions:** trigger a producing write on the API pod (e.g. expense approve); observe the worker.
- **Expected:** the API pod's `initEventBus()` created a `KafkaBus` (producer connects lazily on first
  publish, `kafka-bus.ts:120`); the event reaches the worker's subscribed consumer. The **worker**
  additionally called `registerConsumers()` + `bus.start()`.
- **Assertions:** the API pod has a producer but **zero running consumers**; the worker logs "kafka
  consumer running"; the event is observed exactly once at the consumer (the G1 regression — API pod
  publishing into a subscriber-less in-process bus — does **not** recur).

### FV2-131 — Tenant derived from the envelope, not the payload
- **Tier:** INT · **Wave:** W1-02 (G2) · **Anchors:** `notification.consumer.ts:23` (`assertEnvelopeTenant`); `topics.ts:41`
- **Actions:** deliver an envelope with `tenantId=T` and a payload that **does not** contain a tenant
  field, under a rebuilt context for `T`. Then deliver one whose envelope tenant **mismatches** the
  rebuilt context.
- **Expected:** the matching envelope is processed; the mismatched/absent-tenant envelope **throws**
  ("event tenant does not match propagated context tenant") and is retried/DLQ'd.
- **Assertions:** there is **no** `payload.tenantId` read anywhere on the consume path (the impossible
  check that threw on every event is gone); `RequestContext.tenantId()` itself throws fail-closed if no
  scope was rebuilt.

### FV2-132 — One shared payload type per topic (producer↔consumer can't drift)
- **Tier:** INT (compile + contract test) · **Wave:** W1-02 · **Anchors:** `payloads.ts` (`EventPayloads`, `PayloadOf`)
- **Actions:** for each `EventTopic`, construct the producer payload via `makeEnvelope(topic, payload)`
  and assert the consumer reads the **same** fields it needs.
- **Expected:** `makeEnvelope` is generically typed to `PayloadOf<T>` (`topics.ts:41`), so a wrong shape
  is a **compile-time** break; recipient hints (`recipientUserId`) are present on every
  notification-bound payload.
- **Assertions:** a contract test per topic confirms producer-emitted keys ⊇ consumer-read keys (no
  `undefined` recipient, no renamed money field). `formatMoney`/render never receives `undefined`.

### FV2-133 — `ApprovalRequested` (user-facing) vs `ApprovalCommand` (workflow→owner) split
- **Tier:** INT · **Wave:** W1-04 · **Anchors:** `payloads.ts:67,85`; `topics.ts:13,15`
- **Actions:** stage an `ApprovalRequested` (from the engine) and an `ApprovalCommand` (from a workflow
  rule) for the same record.
- **Expected:** `ApprovalRequested` carries a `RecipientHint` and is consumed by **notification**;
  `ApprovalCommand` carries **no recipient** and is consumed by the **owning service** to auto-decide/
  route. They are **distinct topics** — the prior producer↔consumer collision cannot recur.
- **Assertions:** notification does **not** subscribe to `ApprovalCommand`; the owning service does
  **not** treat `ApprovalRequested` as a command (no double-action).

### FV2-134 — Workflow rule fires on a **real** domain trigger (no phantom topic)
- **Tier:** E2E (pending domain emit) · **Wave:** W1-03 (G6) · **Anchors:** `topics.ts:19,20` (`RecordCreated/Updated`); `apps/workflow/src/consumers`
- **Actions:** perform a domain write that the engine evaluates (the producer emits
  `RecordCreated/RecordUpdated`, **or** workflow is repointed at the concrete domain topic).
- **Expected:** the rule engine evaluates against a **produced** fact stream; a subscriber with **no**
  producer no longer exists.
- **Assertions:** enumerate every `bus.subscribe(topic)` in `apps/workflow/src/consumers` and assert
  each subscribed topic has **at least one** producer in `apps/*` (a static contract check the agent
  runs). Flag any orphan in `BUGLOG.md` (this is the W1-03 surface still partly pending).

### FV2-135 — `await`ed publish (no fire-and-forget on the engine path)
- **Tier:** INT · **Wave:** W1-04 · **Anchors:** `approval.service.ts:446` (`await stageOutboxEvent`)
- **Assertions:** every `stageOutboxEvent`/publish on the approval + domain paths is `await`ed inside
  the transaction; no floating promise drops an event under load.

### FV2-136 — Correlation id propagates unchanged across an async hop
- **Tier:** E2E · **Wave:** W1-01/02 (× v1 FLOW-090) · **Anchors:** `topics.ts:49`; `kafka-bus.ts:143,331`
- **Actions:** trigger producer → relay → Kafka → consumer.
- **Expected:** the `correlationId` stamped at produce time appears **unchanged** in the Kafka message
  header, in the rebuilt consumer `RequestContext`, and in the consumer's log/audit lines.
- **Assertions:** one correlation id threads the whole chain; a missing producer correlation id is
  back-filled once (`randomUUID`) and then stable.

---

## Suite N — Optimistic locking (`lock_version`)

### FV2-140 — Concurrent approvers: stale write → 409
- **Tier:** INT (two transactions) **+ E2E** · **Wave:** W2-08 (G19) · **Anchors:** `base-model.ts:8,53` (`versionedModelOptions`)
- **Preconditions:** a mutable aggregate (e.g. `expense_reports`/`invoices`/`pay_runs`) at
  `lock_version=k`.
- **Actions:** two sessions read the row at `k`; both attempt a status-moving update.
- **Expected:** the first update succeeds and bumps `lock_version=k+1`; the second (still holding `k`)
  throws Sequelize `OptimisticLockError` → mapped to **HTTP 409** `E_CONFLICT`
  (`error-utils.ts:25`). No lost update.
- **Assertions:** the row reflects only the first writer's change; the loser receives 409 and may
  re-read + retry; the audit log records one successful transition, not two.

### FV2-141 — `lock_version` ≠ domain `version` (no collision)
- **Tier:** INT · **Wave:** W2-08 · **Anchors:** `base-model.ts:4-8`
- **Assertions:** optimistic locking maps to **`lock_version`**, deliberately distinct from
  effective-dating columns named `version` (e.g. `tax_rules.version`). A model with a domain `version`
  column still locks on `lock_version` and does not corrupt the domain counter.

### FV2-142 — Model registry applies versioning consistently
- **Tier:** INT · **Wave:** W2-09 (G19) · **Anchors:** `libs/db/src/model-registry.spec.ts`; `base-model.ts:64`
- **Assertions:** every **mutable aggregate root** opts into `version:true` via the registry; append-only
  tables (`*_activities`, `approvals` vote ledger, `audit_log`, `ledger_entries`) **do not** (they are
  immutable). A drift (a new aggregate added without versioning) is caught by the registry test.

---

## Suite O — Idempotency-replay middleware

### FV2-150 — First response cached, retry replayed verbatim
- **Tier:** INT · **Wave:** W2-11 (G38) · **Anchors:** `idempotency.middleware.ts:44`
- **Preconditions:** a mutating route (`POST`) behind the middleware; a fake `CacheAdapter`.
- **Actions:** send `POST` with `Idempotency-Key: K` (creates a resource); send the **same** request +
  `K` again.
- **Expected:** first request executes the handler and the response is stored per `(tenant, K)` on
  `finish`; the retry is served from cache **without re-executing** the handler, with header
  `Idempotent-Replayed: true` and the **same status + body**.
- **Assertions:** the underlying write happened **once** (one DB row); the stored record carries
  `{status, body, storedAt}`; TTL = `IDEMPOTENCY_TTL_SECONDS`/86400.

### FV2-151 — Idempotency key is tenant-scoped (no cross-tenant replay)
- **Tier:** INT · **Wave:** W2-11 · **Anchors:** `idempotency.middleware.ts:56` (`CacheAdapter.tenantKey`)
- **Actions:** tenant A `POST` with key `K`; tenant B `POST` with the **same** key `K`.
- **Expected:** B's request **executes** (different namespaced cache key) — B never receives A's cached
  body.
- **Assertions:** the two cache keys differ by `RequestContext.tenantId()` prefix; no collision/leak.

### FV2-152 — 5xx is not stored (server errors stay retryable); no key passes through
- **Tier:** INT · **Wave:** W2-11 · **Anchors:** `idempotency.middleware.ts:83`; `:54`
- **Actions:** (a) a handler that returns 500 with `K`, then retry; (b) a request **without** the
  header.
- **Expected:** (a) the 500 is **not** cached (`statusCode >= 500` skip); the retry re-executes. (b)
  no-key request passes straight through (opt-in).
- **Assertions:** only non-5xx (2xx/3xx/4xx-deterministic) responses are stored; `GET`/excluded
  `/health` are never guarded.

### FV2-153 — Cache outage fails OPEN (writes not blocked)
- **Tier:** INT · **Wave:** W2-11 · **Anchors:** `idempotency.middleware.ts:61`
- **Actions:** make `CacheAdapter.get` throw; send a keyed `POST`.
- **Expected:** the middleware **processes normally** (no replay) and logs a warning — a Redis blip
  must not block writes.
- **Assertions:** the handler runs; a `Logger.warn` is emitted; no 5xx caused by the cache failure.

---

## Suite P — Graceful shutdown drain

### FV2-160 — SIGTERM: stop listener → drain in-flight → LIFO hooks under deadline
- **Tier:** INT · **Wave:** W2-01 (G11/G37) · **Anchors:** `shutdown.ts:59` (`runShutdown`), `:107`
- **Preconditions:** hooks registered via `onShutdown` for (in order) DB pool (`closeSequelize`), bus
  (`bus.stop()`), relay (`stopOutboxRelay`), Redis quit.
- **Actions:** invoke `runShutdown({server, reason:'SIGTERM'})` with an in-flight request pending.
- **Expected:** `server.close` stops **new** connections and drains the in-flight one; then hooks run
  in **LIFO** (reverse registration) order; each best-effort (a throwing hook is logged, not fatal to
  the rest).
- **Assertions:** `shutdownHookNames()` order reversed at run; in-flight request completes with its
  real response (not dropped mid-write); the sequence is **idempotent** across repeated signals
  (`shuttingDown` guard).

### FV2-161 — Hung dependency forced-exit under hard deadline
- **Tier:** INT · **Wave:** W2-01 · **Anchors:** `shutdown.ts:65` (deadline race), `:69` (`Logger.alert`)
- **Actions:** register a hook that never resolves; run with `timeoutMs=200`.
- **Expected:** `Promise.race` resolves on the deadline; a `Logger.alert("graceful shutdown timed
  out…")` fires; the process is allowed to force-exit — a wedged dep can't hold the pod forever.
- **Assertions:** total wall time ≈ `timeoutMs`, not unbounded.

### FV2-162 — Consumer/relay drain before exit (no message loss on restart)
- **Tier:** E2E · **Wave:** W2-01 (G37) × W2-06 · **Anchors:** `kafka-bus.ts:183` (`stop`); `outbox.ts:216` (`relay.stop`)
- **Actions:** SIGTERM a worker mid-drain.
- **Expected:** the bus disconnects consumers + producer cleanly; the relay stops polling; any
  in-flight outbox row stays `pending` (re-drained by the next/another relay). No partially-committed
  offset drops an unhandled message.
- **Assertions:** after restart, the pending event is delivered exactly once at the (idempotent)
  consumer.

---

## Suite Q — Notification completeness

### FV2-170 — Recipient fan-out (hint → resolved recipient set)
- **Tier:** INT · **Wave:** W3-09 (G16) · **Anchors:** `notification.service.ts:47` (`resolveAndDispatch`); `recipient-resolver.service.ts`
- **Preconditions:** an event carrying a `RecipientHint` (`recipientUserId`); the resolver enriches
  userId → email/phone.
- **Actions:** deliver the event.
- **Expected:** the consumer builds a `{kind:'user',userId,email}` spec; the resolver returns the
  concrete recipient(s); the service fans out **one** `createAndDispatch` per resolved recipient.
- **Assertions:** producers **no longer name channels/addresses** beyond the hint; one recipient's
  failure **bubbles** (so the bus retries/DLQs) rather than silently swallowing the rest.

### FV2-171 — Per-channel preferences (default-on, explicit opt-out)
- **Tier:** INT · **Wave:** W3-10 (G17) · **Anchors:** `notification.service.ts:139` (`channelEnabled`); `0014_notification_preferences.ts`
- **Preconditions:** a `notification_preferences` row disabling **email** for `(user, event_type)`; no
  row for **in-app** or **SMS**.
- **Actions:** dispatch a notification of that `event_type` to the user.
- **Expected:** in-app row created (default-on); email **suppressed** (explicit `enabled=false`);
  SMS sent only if a phone exists (default-on).
- **Assertions:** **absence** of a row = delivered (default-on); a NULL-`user_id` row is the
  **tenant-wide default** for `(event_type, channel)`; the two partial-unique indexes prevent duplicate
  prefs.

### FV2-172 — Idempotent in-app + email + SMS ledger (exactly-once at recipient)
- **Tier:** INT · **Wave:** W3-12 × §5 · **Anchors:** `email-sender.service.ts:24` (`findOrCreateForUpdate`/`markSent`); `notification.service.ts:80` (`baseKey`)
- **Actions:** deliver the **same** logical event twice (relay re-drain / Kafka redelivery).
- **Expected:** in-app row `createIfAbsent` (one row); email/SMS `idempotency_key` UNIQUE ledger
  short-circuits when already `sent` (no second provider send).
- **Assertions:** the email log row is **never** left `pending` (success → `sent`, exception →
  `failed` + `error_message` then **rethrow** so the bus retries/DLQs). The idempotency key is
  `code:businessKey:userId:correlationId`-derived (does **not** over-collapse distinct events — G45).

### FV2-173 — Templates rendered via the named renderer (no inline strings; no `NaN`)
- **Tier:** INT · **Wave:** W3-12 (G40) · **Anchors:** `content-map.ts` (`render`); `template-engine.ts`
- **Actions:** render each `NotificationCode` message.
- **Expected:** a named template per code produces `{subject, body}`; money is formatted from a real
  integer minor-units value (never `formatMoney(undefined) = NaN` — the old G3 defect).
- **Assertions:** every code in `NotificationCode` has a template; missing recipient/amount is caught
  upstream by the typed payload, not silently rendered as `undefined`/`NaN`.

### FV2-174 — SMS channel parity (port + sender)
- **Tier:** INT · **Wave:** W3-12 · **Anchors:** `sms-sender.service.ts`; `sms-provider.service.ts`
- **Actions:** dispatch to a recipient with a phone and SMS enabled.
- **Expected:** the SMS sender uses the same idempotent ledger pattern as email (`sms:` key prefix);
  the provider is a swappable port.
- **Assertions:** SMS send is gated by the SMS preference and the presence of a phone; redelivery is a
  no-op.

### FV2-175 — Anti-ambient-authority: notification never re-authorizes
- **Tier:** INT · **Wave:** §6 × W1-02 · **Anchors:** `notification.consumer.ts:23`; `notification.service.ts:76`
- **Assertions:** every handler reads tenant from the **envelope** (asserted == rebuilt context),
  never makes its own access decision, and writes only under the propagated tenant. A
  cross-tenant/absent-tenant envelope fails closed.

### FV2-176 — Inbox scoping (own-only) — Wave depth of v1 FLOW-081
- **Tier:** INT · **Wave:** §4 · **Anchors:** `notification.service.ts:149` (`listForUser`), `:171` (`markRead`)
- **Assertions:** `listForUser` filters to `RequestContext.userId()`; `markRead` mutates only an
  **owned** row (else NotFound) — a user can't read/mutate another user's inbox; cross-tenant is
  RLS-blocked.

### FV2-177 — Per-code kill-switch suppresses delivery
- **Tier:** INT · **Wave:** W3-10 (ops override) · **Anchors:** `notification.service.ts:51` (`isCodeEnabled`)
- **Assertions:** with a code globally disabled, `resolveAndDispatch` short-circuits with a log and
  writes **nothing** (no in-app row, no provider send) — the global kill-switch overrides per-user
  prefs as an ops control.

### FV2-178 — Dispatch atomicity (one RLS-scoped tx per recipient)
- **Tier:** INT · **Wave:** W3-09 × §4 · **Anchors:** `notification.service.ts:82` (`withTenantTransaction`)
- **Assertions:** in-app + email + SMS for one recipient commit/rollback together; a provider exception
  rolls back the in-app row for that recipient too (no half-delivered state), and rethrows for bus
  retry.

---

## Suite R — ERP via consumer (off the request path)

### FV2-180 — Approval/disbursement stages `ConnectorPushRequested`; consumer pushes off-path
- **Tier:** INT · **Wave:** W2-07 (G29) · **Anchors:** `connector-sync.consumer.ts:61` (`pushFromEvent`); `payloads.ts:146`
- **Preconditions:** the producer (invoice approve / pay-run disburse) stages a
  `ConnectorPushRequested` event in the **same tx** as the approval write (transactional outbox).
- **Actions:** relay drains → worker consumes.
- **Expected:** the synchronous in-request `ConnectorRegistry.get(kind).pushTransaction(...)` is
  **gone** from the request path; the push runs in the **worker** role, addressed by `connectorKind`
  + `entity` from the payload.
- **Assertions:** the user's approve/disburse response does **not** block on the ERP; a slow ERP no
  longer delays the request.

### FV2-181 — Idempotent push: redelivery is a no-op
- **Tier:** INT · **Wave:** W2-07 · **Anchors:** `connector-sync.consumer.ts:78`; `BaseConnector` idempotencyKey
- **Actions:** deliver the **same** `ConnectorPushRequested` twice (relay re-drain / rebalance).
- **Expected:** `BaseConnector` pushes **at most once** per `idempotencyKey` (the invoice/pay-run id);
  the second delivery returns the first push's cached result — **no** duplicate ERP record.
- **Assertions:** exactly one external record; the second handler invocation still records its
  (best-effort) audit outcome without re-hitting the ERP.

### FV2-182 — Transient ERP failure → retried → dead-lettered; permanent parked
- **Tier:** E2E (Kafka) · **Wave:** W2-07 × W1-05 · **Anchors:** `connector-sync.consumer.ts:130` (handler rethrows)
- **Actions:** make the connector throw transiently, then permanently.
- **Expected:** the handler **rethrows** so the bus applies bounded retry + backoff; on exhaustion the
  envelope is dead-lettered to `connector.push.requested.dlq` (recoverable), not silently lost.
- **Assertions:** transient failure eventually succeeds on retry; permanent failure lands in the DLQ
  with error/attempts headers.

### FV2-183 — Push outcome recorded to audit (best-effort, never re-pushes)
- **Tier:** INT · **Wave:** W2-07 × §10 · **Anchors:** `connector-sync.consumer.ts:96` (`recordPushOutcome`)
- **Actions:** push succeeds but the audit write throws.
- **Expected:** an `AuditLogger.record` with `outcome=success/failure`, `resourceType/Id`,
  connector details, idempotency key; an **audit-write failure is logged, not thrown** — so a push the
  ERP already accepted is **not** redelivered just because the trail write failed.
- **Assertions:** no endless redeliver loop; a `CONNECTOR_SYNC_AUDIT` error is surfaced for forensics.

---

## Suite S — Gateway upstream resilience

### FV2-190 — Upstream timeout → 504, correlation echoed
- **Tier:** INT (mock upstream) **+ E2E** · **Wave:** W2-04 (G13) · **Anchors:** `proxy.ts:62-87`
- **Preconditions:** `GATEWAY_UPSTREAM_TIMEOUT_MS` small; an upstream that sleeps past it.
- **Actions:** route a request through `proxyHandler`.
- **Expected:** the `AbortController` fires; the gateway returns **504** `E_GATEWAY_TIMEOUT` with the
  envelope `{errors:[{code,type:'GATEWAY',message,correlationId}]}` and the `X-Correlation-Id` header
  echoed.
- **Assertions:** the gateway never hangs; the body + header carry the same correlation id; a
  `gateway upstream timeout` warning logs `svc` + `timeoutMs`.

### FV2-191 — Connection refused → 503
- **Tier:** INT · **Wave:** W2-04 · **Anchors:** `proxy.ts:91` (`ECONNREFUSED → 503`)
- **Actions:** point a route at a dead port.
- **Expected:** **503** `E_UPSTREAM_UNAVAILABLE`, correlation echoed.
- **Assertions:** `errorCode(err)` reads `err.cause.code` (Node fetch) and maps `ECONNREFUSED`→503.

### FV2-192 — Host unreachable / reset / DNS fail → 502
- **Tier:** INT · **Wave:** W2-04 · **Anchors:** `proxy.ts:15` (`UNREACHABLE_CODES`), `:91`
- **Actions:** induce `ENOTFOUND`/`ECONNRESET`/`EHOSTUNREACH`.
- **Expected:** **502** `E_BAD_GATEWAY`, correlation echoed.
- **Assertions:** every unreachable code path returns a typed gateway error, never a raw stack or a
  hang; `headersSent` guard prevents a double-send.

### FV2-193 — Unknown route segment → 404 (not a proxy hang)
- **Tier:** INT · **Wave:** W2-04 · **Anchors:** `proxy.ts:46`
- **Assertions:** an unrouted first path segment returns `notFound` before any upstream fetch.

---

## Suite T — RLS & integrity (Wave depth)

### FV2-200 — Cross-tenant isolation on the new approval/outbox/notification tables
- **Tier:** E2E (RLS) **+ INT** · **Wave:** W1/W2/W3 schema · **Anchors:** `0012_approvals.ts:222`; `0011_event_outbox.ts`; `0014_notification_preferences.ts`
- **Actions:** under `app.current_tenant=A`, raw-SELECT B's rows in `record_approvers`, `approvals`,
  `approver_groups`, `event_outbox`, `notification_preferences`, `activity_log`.
- **Expected:** **0 rows** for every table (FORCE + RESTRICTIVE policy keyed on `app.current_tenant`).
- **Assertions:** the **only** path that sees cross-tenant rows is the relay with
  `app.outbox_relay='on'` set transaction-locally (`outbox.ts:143`) — assert no API/handler path sets
  that marker.

### FV2-201 — Hash-chain stays contiguous under concurrent appends (tail lock)
- **Tier:** INT (two concurrent tx) **+ E2E** · **Wave:** W1-11 (G41) · **Anchors:** `audit-logger.ts` (tail `FOR UPDATE`); `:101` (`verifyChain`)
- **Actions:** two concurrent audit appends race to anchor on the same tail.
- **Expected:** the tail is locked (`FOR UPDATE` / monotonic sequence) so the two appends serialize —
  no fork, no two entries sharing a `prev_hash`.
- **Assertions:** `verifyChain` returns `{valid:true}`; re-walk order is `(created_at ASC, id ASC)`,
  the same key the appender anchors against; entry hash = `H(prev_hash || canonical(entry))`.

### FV2-202 — Tamper detection pinpoints the first broken entry
- **Tier:** INT · **Wave:** §10 (× v1 FLOW-093) · **Anchors:** `audit-logger.ts:113`
- **Actions:** in a copy, flip one byte of a historical entry's payload; `verifyChain`.
- **Expected:** `{valid:false, brokenAt:<id>}` at the **first** altered entry; every entry after it
  also fails to chain.
- **Assertions:** column names are `hash`/`prev_hash` (not `entry_hash`); the chain is otherwise intact
  before the break.

### FV2-203 — Partial-unique recreate-after-soft-delete (no 23505)
- **Tier:** INT (live DB) · **Wave:** W1-07 (G5) · **Anchors:** `0011`/migration with `WHERE deleted_at IS NULL`; template `0004_workflow.ts:64`
- **Preconditions:** a paranoid table (`users`, `expense_categories`, `expense_reports`,
  `pay_calendars`, `earning_codes`, `deduction_codes`, plus `tenants.slug`, `roles(tenant_id,name)`).
- **Actions:** create natural key `N` → **soft-delete** it (`deleted_at` set) → **recreate** `N`.
- **Expected:** recreate **succeeds** (the unique index is partial, scoped to live rows); **no**
  `23505 unique_violation`.
- **Assertions:** two live rows with the same `N` is still rejected; the soft-deleted row coexists.
  The agent runs this for **every** listed table (the regression was applied to `rules` only and
  nowhere else before W1-07).

### FV2-204 — `record_approvers` live partial-unique allows same approver after supersede
- **Tier:** INT · **Wave:** W3-06 · **Anchors:** `0013_approvals_supersede.ts:42` (`WHERE is_active`)
- **Actions:** approver A1 at level 1 is reassigned away, then reassigned **back** to A1.
- **Expected:** the second A1 slot is allowed because the unique index is `WHERE is_active` and the
  prior A1 slot is `is_active=false`.
- **Assertions:** two **active** A1 slots at the same level are still rejected; the superseded one
  persists for history.

### FV2-205 — Notification preference uniqueness (user-row vs tenant-default)
- **Tier:** INT · **Wave:** W3-10 · **Anchors:** `0014_notification_preferences.ts:51` (two partial-unique indexes)
- **Actions:** insert a `(user_id, event_type, channel)` pref and a NULL-`user_id` tenant default for
  the same `(event_type, channel)`.
- **Expected:** both allowed (distinct partial-unique scopes); a duplicate of either is rejected.
- **Assertions:** dispatch consults the **user** row first, falling back to the tenant default, falling
  back to default-on.

---

## Tier summary — what runs now vs Docker-gated

| Tier | Runs against | FV2 flows |
|---|---|---|
| **INT (now)** — in-process bus, transactional/mocked DB, fake cache/email/SMS/connector | no brokers, no extra pods | FV2-100…114 (engine), 120/121/122/124/126, 131/132/133/135, 140/141/142, 150…153, 160/161, 170…178, 180/181/183, 190…193, 200(INT slice)/201/202/203/204/205 |
| **E2E (Docker-gated)** — real Postgres+RLS, Redis, Kafka brokers, `PROCESS_TYPE` roles | `scripts/dev-up.sh` + worker/relay/api pods | FV2-113(E2E), 123, 125, 130, 134, 136, 140(E2E), 162, 182, 190(E2E), 200(E2E), 201(E2E) |
| **E2E (pending domain wiring)** — engine ↔ domain not yet connected | flag in `BUGLOG.md` | FV2-100…114 E2E slice (expense/invoice/payroll → `@aegis/approvals`), FV2-134 (workflow real trigger) |

## How the agents consume FLOWS v2

- Run **INT** flows first (fast, hermetic) — they gate every `E2E` flow that depends on the same
  surface. An INT failure blocks promoting that surface to `E2E`.
- For each flow, assert **every** Expected + Assertion line and the **Cannot** (negative) cases; a
  flow PASSES only when the denials deny and the idempotent paths stay idempotent.
- On any mismatch (a dual-write that escaped, a redelivery that double-applied, a 409 that silently
  lost an update, a DLQ that dropped a poison message, a cross-tenant row that surfaced, a broken hash
  chain, a 23505 on recreate, a missing producer for a subscribed topic), append to `BUGLOG.md`
  `{ id, flow:"FV2-NNN", severity, repro, expected, actual, status }` and cross-reference the backlog
  id (`W…`/`G…`).
- Where this plan marks **pending wiring**, the agent records the gap (engine-built-but-not-invoked,
  orphan-subscriber) rather than reporting a behavioral failure.
