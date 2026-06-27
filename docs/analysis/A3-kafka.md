# A3 — Kafka Integration + API-vs-Consumer Deployment (Track A: architecture-reference fidelity)

**Reference (architecture):** the architecture reference — `src/clients/kafka-client/**`, `src/bootstrap.ts`, `src/util.ts`
**Ours:** `aegis` — `libs/events/src/**`, `apps/{workflow,notification}/src/{bootstrap,consumers}`, the producers in `apps/{expense,invoice,payroll}/src/services`, `docker-compose.all.yml`, `scripts/start.sh`
**Verdict:** The transport mechanics (queue, back-pressure pause/resume, manual commit, bounded retry) are a faithful, well-written port. **But the eventing system is non-functional end-to-end**: every cross-service domain event published by a producer API pod is dropped before it reaches Kafka, the topic contract is mismatched producer↔consumer on every notification topic, one consumer subscribes to a topic no one emits, and there is no DLQ. The owner's doubt is correct — this refactor matched the reference's *plumbing* but not its *deployment invariant* (producer connected on every pod) or its *topic contract discipline*.

---

## 1. How the architecture reference actually works (ground truth)

### 1.1 The producer is connected on EVERY pod, independent of consumer role
Architecture reference `src/bootstrap.ts:32-61`:

```ts
const initConsumer = process.env.ENABLE_KAFKA_MODE === "false" ? false : true;
const initProducer = process.env.ENABLE_KAFKA_PRODUCER === "false" ? false : true;
...
if (initProducer) await initializeProducer();   // line 55  — DEFAULTS TRUE on every pod
let topicConsumerInstanceObj = {};
if (initConsumer) topicConsumerInstanceObj = await initializeConsumer();  // line 57-59
```

The two flags are **orthogonal**. `initProducer` defaults to `true` and is only disabled by an explicit `=== "false"`. So **the Kafka producer is connected on every pod the reference ever boots — API pods and consumer pods alike.** `KafkaProducer.initProducer` (`KafkaProducer.ts:19-57`) does `producer.connect()` for each cluster at boot, and `KafkaProducer` is a `static` singleton (`KafkaProducer.ts:6-12`) so any code path calling `sendData(...)` hits an already-connected producer. There is no "in-process fallback bus" in the reference — a service that can't reach Kafka simply fails to emit.

**This is the load-bearing invariant Aegis broke.** (See §2(a).)

### 1.2 The HTTP server runs on every pod too; "consumer mode" is a flag, not a separate image path
Architecture reference `src/bootstrap.ts:36` calls `initializeServer(initConsumer)` unconditionally; the Express server is always built and listens (`index.ts:166`). The reference records its deployment intent via `ContextManager.deploymentMode = mode ? "KAFKA" : "WEB"` (`bootstrap.ts:91`) but still binds HTTP. The "API vs consumer" split is environment-flag-driven on the same image — which Aegis mirrors more cleanly with `PROCESS_TYPE` (a justified improvement, §3).

### 1.3 Consumer transport: queue + back-pressure + manual commit + bounded retry
Architecture reference `src/clients/kafka-client/Consumer.ts`:
- One `kafka.consumer({ groupId, maxBytes })` **per topic per instance** (`noOfInstances`), each with its own `async.queue` of width `maxParallelHandles` (`Consumer.ts:90-105`).
- `eachMessage` pushes to the in-memory queue; if `queue.length() > maxQueueSize` it **pauses** the consumer (`Consumer.ts:155-162`); the queue's `drain()` **resumes** it (`Consumer.ts:108-115`). Classic back-pressure.
- `autoCommit:false` path uses `CommitManager` (`CommitManager.ts`) to track per-partition processed offsets and commit `offset+1` of the last contiguous processed record (`CommitManager.ts:45-83`) — at-least-once.
- `handleCB` (`Consumer.ts:198-247`) retries a failing handler up to `retryHandlerMaxNo` (or `retryHandlerInfinite`), `delay(5000)` between attempts; on exhaustion it **commits anyway** (`Consumer.ts:233-240`) to avoid head-of-line blocking.
- Per-message context is rebuilt in the handler from headers: `ReqContextManager.populateFromHeaders({ headers }, false, true)` then `AuthMiddleware.setUserMetaInContext()` (`handlers/configUploadHandler.ts:48-49`). The producer stamps those headers (`X-Tenant-Id`, `X-Tracker`, `correlationId`, …) in `KafkaProducer.sendData` (`KafkaProducer.ts:69-81`).

### 1.4 SUICIDE for consumer pods
Architecture reference `src/util.ts:336-347` — `setConsumerSuicideTimer` schedules a randomized self-restart: it first `await Consumer.pauseAll(topicConsumerObj)` (`Consumer.ts:12-30`) so in-flight queues drain to a clean commit boundary, then flips `HealthCheckController.isSuicideTimerExpired = true` so the health check fails and the orchestrator restarts the pod. The API-pod variant `setSuicideTimer` (`util.ts:324-334`) skips the pause (no consumers to quiesce). `bootstrap.ts:379-385` picks one based on `POD_SUICIDE_ENABLED` vs `CONSUMER_SUICIDE_ENABLED`. **This graceful-drain-before-restart for consumer pods has no equivalent in Aegis** (§4, missing).

### 1.5 Does the architecture reference DLQ? No.
There is no dead-letter topic anywhere in the architecture reference. Its poison-message strategy is twofold: (1) on retry exhaustion it **commits and moves on** (`Consumer.ts:233-240`), and (2) a *validation* failure in the handler returns `true` to skip-and-commit immediately (`configUploadHandler.ts:64` — `if (err === "Kafka_Validation_Error") return true;`). So the reference "drops poison after N retries" — same as Aegis's bus. A DLQ would be an *enterprise improvement over the reference*, not a regression from it (§4).

---

## 2. The confirmed bugs — reference-faithful diagnosis

### (a) Producer pods never `setBus(new KafkaBus())` → domain events are dropped — **CRITICAL REGRESSION**
- `apps/expense/src/services/expense.service.ts:396-397` publishes via `getBus().publish(makeEnvelope(...))`. `getBus()` returns the module default `InProcessBus` (`libs/events/src/bus.ts:47-51`).
- Only the **worker** bootstraps call `setBus(new KafkaBus(...))`: `apps/workflow/src/bootstrap.ts:25-28` and `apps/notification/src/bootstrap.ts:23-25`, both gated on `PROCESS_TYPE==='worker'`.
- `docker-compose.all.yml:91-107,134-137` run `expense`, `invoice`, `payroll` with **only `SERVICE_NAME`** — no `PROCESS_TYPE=worker`. So those API pods take the `else` branch of their bootstrap and **never swap the bus**.
- Net effect: an expense-approval event published in the `expense` API pod goes into that pod's in-memory `InProcessBus` map, which has **zero subscribers** (the notification/workflow handlers are registered in *separate* worker processes). The event is silently dropped. **Nothing crosses Kafka. The entire cross-service event system is dead in the distributed deployment.**

**Reference-faithful fix:** mirror the architecture reference's `bootstrap.ts:55` — connect the Kafka producer on **every** pod, not just workers. Concretely, in the shared service bootstrap (or each producer's `bootstrap.ts`), call `setBus(new KafkaBus(...))` whenever Kafka is enabled, regardless of `PROCESS_TYPE`. The worker role additionally calls `bus.start()` (consumers); the API role only needs a connected producer. `KafkaBus` already lazy-connects the producer on first `publish` (`kafka-bus.ts:104-115`) and never starts consumers unless `start()` is called — so a single shared "if KAFKA_ENABLED: setBus(new KafkaBus())" in the common bootstrap is safe for API pods. Keep `InProcessBus` as the default only for the single-image local run (no broker).

### (b) Notification consumer expects `tenantId`/`recipient*` the producers never send — **CRITICAL REGRESSION**
- Consumer contract (`libs/shared/types/src/notification.shape.ts:174-203`): every consumed payload `extends ConsumedPayloadBase { tenantId; recipientUserId; recipientEmail? }`.
- The consumer **hard-asserts** tenant (`apps/notification/src/consumers/notification.consumer.ts:9-14` — `assertContextTenant` throws if `payload.tenantId` missing/mismatched) and reads `recipientUserId`/`recipientEmail` (`notification.consumer.ts:16-18`).
- Producers send **none** of these:
  - Expense `ExpenseApproved` (`expense.service.ts:249-254`): `{ reportId, status, totalAmount, approverId }` — no `tenantId`, no `recipientUserId`, wrong key (`approverId` vs consumer's `approvedBy`), wrong key (`totalAmount` vs `amountMinor`).
  - Invoice `InvoiceApproved` (`invoice.service.ts:260`): `{ invoiceId, status }` only — the rich `pushPayload` with `vendorName/amountMinor` (`invoice.service.ts:246-256`) is built but **never put in the envelope**. No tenant/recipient.
  - Payroll `PayRunApproved` (`pay-run.service.ts:165-167`): `{ payRunId, approvedBy }` — no tenant/recipient.
- Even if (a) were fixed and events reached the consumer, **every notification handler would throw at `assertContextTenant`** (payload.tenantId is `undefined`), exhaust retries, and the message would be dropped.

**Reference-faithful fix:** the reference carries tenant/correlation **in headers** and rebuilds context on consume (`KafkaProducer.ts:69-81` → `configUploadHandler.ts:48`). Aegis already does the header+context rebuild in `kafka-bus.ts:117-134` (publish stamps `tenantId`) and `kafka-bus.ts:256-271` (`dispatch` runs each handler inside `RequestContext.run` rebuilt from the envelope's `tenantId`). So `RequestContext.tenantId()` *is* available to the consumer — `assertContextTenant` should compare against the **envelope tenant** (already in context), and the producer must put `recipientUserId`/`recipientEmail` (and the renamed money/actor fields) **into the payload**. Fix both ends to a single shared payload type (the `NotificationShape.*Payload` interfaces) and make the producers construct exactly those.

### (c) Workflow subscribes to `record.created`/`record.updated` that no producer emits — **REGRESSION (dead subscription)**
- `apps/workflow/src/consumers/index.ts:14-17` maps `RecordCreated`→`RuleEvent.RecordCreated` and `RecordUpdated`→`RuleEvent.RecordUpdated`, and `registerConsumers` subscribes to both (`index.ts:27-32`).
- **No service emits `RecordCreated`** anywhere (grep: only the enum/topic definitions, a spec test, and this subscriber). **No domain service emits `RecordUpdated`** either — the *only* `RecordUpdated` emitters are workflow's own builtin actions (`apps/workflow/src/engine/actions/builtin.ts:52,66`), i.e. the worker emitting to itself.
- Result: the workflow rule engine **never auto-fires from real domain writes** (expense/invoice/payroll create/update). The whole "rules-as-data auto-run on domain events" capability is wired to topics with no upstream producer.

**Reference-faithful fix:** decide the contract and make producers honor it. Either (i) have expense/invoice/payroll emit `RecordCreated`/`RecordUpdated` envelopes (generic `{recordType, recordId, ...facts}`) on their writes — the contract the engine expects — or (ii) subscribe workflow to the concrete domain topics (`expense.submitted`, `invoice.received`, …) and translate. (i) matches the engine's `Facts` model best. Until one is done, this subscription is dead code.

### (d) `ApprovalRequested` payload mismatch producer↔consumer — **REGRESSION**
- Producer (`apps/workflow/src/engine/actions/builtin.ts:22-30, 37-44`) emits `ApprovalRequested` with `{ recordType, recordId, autoApprove?/policyId?, ruleId, reason? }`.
- Consumer (`apps/notification/src/consumers/notification.consumer.ts:52-64`) reads `{ approvalId, subjectType, subjectId, requestedBy }` and asserts `tenantId` — i.e. the `ApprovalRequestedPayload` shape (`notification.shape.ts:193-198`). **Disjoint** from what the producer sends. Plus the producer **doesn't `await`** the publish (`builtin.ts:22` — `getBus().publish(...)` with no `await`), so in the Kafka path a send error is an unhandled rejection.

**Reference-faithful fix:** one shared `ApprovalRequestedPayload` type both sides import; the workflow action builds exactly that (resolve `subjectType/subjectId` from `recordRef`, set `requestedBy` from context, include `recipientUserId`), and `await` the publish.

### (e) No DLQ on retry exhaustion — **MISSING (enterprise gap; the reference also lacks it but we claim one)**
- `kafka-bus.ts:236-253`: after `retryHandlerMaxNo` attempts, `handleWithRetry` just `return`s — the offset is then committed by `drain` (`kafka-bus.ts:216-220`), so **the poison message is silently dropped.** Functionally identical to the reference (§1.5).
- But `apps/notification/src/services/email-sender.service.ts:54` comments `throw err; // bubble so the bus applies its retry / dead-letter policy` — **there is no dead-letter policy.** The comment lies; the message is lost with no forensic trail.

**Fix (improve on the reference):** on retry exhaustion, publish the failed envelope (plus error + attempt count + original topic/offset) to a `<topic>.dlq` (or a single `events.dlq`) before committing. This is an enterprise capability *neither* reference had; building it is the right call for an access-control platform where lost events = lost authorization side effects.

---

## 3. Where Aegis matches or improves the reference (justified)

- **Transport port is faithful and cleaner.** `kafka-bus.ts` reproduces the reference's per-topic queue (`drain` loop, `kafka-bus.ts:209-233`), back-pressure pause/resume (`enqueue`/`drain`, `kafka-bus.ts:200-205, 225-229`), `autoCommit:false` + manual `commitOffsets(offset+1)` (`kafka-bus.ts:157, 216-220`), and bounded retry with delay (`handleWithRetry`, `kafka-bus.ts:236-253`) — the same semantics as `Consumer.ts` + `CommitManager.ts`, in ~1/3 the code. **Justified.**
- **Context rebuild on consume is preserved.** `dispatch` runs handlers inside `RequestContext.run` rebuilt from the envelope (`kafka-bus.ts:256-271`), the analog of `populateFromHeaders` in the reference handler. Tenant + correlation propagate across the async hop. **Justified (and is the mechanism that makes the §2(b) fix easy).**
- **`PROCESS_TYPE` single-image role fork** (`scripts/start.sh`, `bootstrap.ts` worker/api branch) is a cleaner expression of the reference's `deploymentMode` flag, and the docker-compose runs real separate `*-worker` services (`docker-compose.all.yml:117-132`). **Justified improvement** — *provided* §2(a) is fixed so producers also connect.
- **Self-describing `EventEnvelope` + `makeEnvelope`** (`topics.ts:22-44`) centralizes tenant/correlation stamping vs the reference's ad-hoc header assembly. **Justified.**
- **Transactional outbox** (`libs/events/src/outbox.ts`) is a capability the reference lacks (the reference double-writes: commit then `sendData`, same as Aegis's invoice/payroll publish-after-commit). The outbox helper exists but **is not used by any producer** (grep: no `withOutbox` callers in `apps/`) — so the dual-write risk is still live. **Justified design, unfinished adoption** → see §4.

---

## 4. Missing enterprise capabilities (the reference has, or platform needs)

| Capability | Reference evidence | Ours | Classify |
|---|---|---|---|
| Graceful consumer drain before pod restart (`pauseAll` → fail health → restart) | `util.ts:336-347`, `Consumer.ts:12-30` | none — `KafkaBus.stop()` exists (`kafka-bus.ts:167-186`) but nothing calls it on SIGTERM | missing |
| `maxParallelHandles` (per-topic handler concurrency) | `Consumer.ts:90-105` | hard-serial `drain` (`kafka-bus.ts:213`); option not honored | missing (minor — serial is safer, but it's a lost throughput knob) |
| Multi-instance per topic (`noOfInstances`) | `Consumer.ts:87-117` | one consumer per topic (`kafka-bus.ts:150-152`) | justified (Kafka partitions + multiple worker pods replace it) |
| Outbox actually used by producers | n/a (reference double-writes) | `outbox.ts` present, **0 callers** | missing (adopt `withOutbox` in expense/invoice/payroll publish paths) |
| DLQ | none (drops poison, §1.5) | none, but code comments claim one (§2e) | missing (build it; improve on the reference) |

---

## 5. Recommended corrected eventing architecture (reference-faithful)

1. **Producer-on-every-pod (fixes 2a).** In the common bootstrap, when Kafka is enabled (`KAFKA_BROKERS` set / `KAFKA_ENABLED`), `setBus(new KafkaBus(...))` for **all** roles. Workers additionally `registerConsumers(); await bus.start()`. API/producer pods get a connected producer and no consumers. Keep `InProcessBus` only as the no-broker local default. This is exactly the architecture reference's `bootstrap.ts:55` (producer init independent of consumer init).
2. **One shared payload type per topic, imported by both ends (fixes 2b, 2c, 2d).** Move every `*Payload` to `@aegis/shared-types` (already there for notification) and make producers construct exactly that shape — including `recipientUserId`/`recipientEmail` and tenant. `assertContextTenant` compares envelope tenant (already in `RequestContext` via `dispatch`) to payload tenant. `await` every `publish`.
3. **Pick the workflow trigger contract (fixes 2c).** Have expense/invoice/payroll emit `RecordCreated`/`RecordUpdated` envelopes on writes (generic record facts), OR repoint workflow at the concrete domain topics. Don't leave a subscriber with no producer.
4. **Envelope = the wire contract.** Keep `EventEnvelope` (`topics.ts:22-30`); partition key = `tenantId` (already `kafka-bus.ts:124`) for per-tenant ordering. Carry tenant/correlation/source in both envelope and headers (`kafka-bus.ts:126-130`).
5. **DLQ on exhaustion (fixes 2e, beats the reference).** In `handleWithRetry`, before giving up, `producer.send` the failed envelope + error metadata to `<topic>.dlq`, then commit. Make the email-sender comment true.
6. **Outbox adoption.** Wrap expense/invoice/payroll commit+publish in `withOutbox` so a rolled-back transaction emits nothing (kills the dual-write the reference also suffers).
7. **Graceful drain (port the reference's SUICIDE intent).** On SIGTERM, `pause` all consumers, drain queues, `await bus.stop()`, then exit — the `pauseAll`-before-restart behavior of `util.ts:336-347`.

**Bottom line:** the reference's *mechanics* were ported well; its *deployment invariant* ("producer connected on every pod") and *contract discipline* ("one payload shape, producer fills it") were not. Fixes 1–3 are required to make any event flow at all; 5–7 raise it to enterprise grade.
