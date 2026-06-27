# ERP Integration — Proxy/Gateway Alignment Analysis

> Current status (2026-06-27): durable sync-state, tenant connector config storage/API, DB-backed
> config resolution, and the expense outbox path are now implemented. Status reconciliation is
> available through a tenant-scoped operator endpoint; the remaining parity gaps are automated
> cross-tenant scheduling, richer attempt metadata, secret resolution/token refresh, and terminal
> callbacks into owning finance records.

**Area:** ERP integration — do we follow the ERP-integration reference's proxy pattern?
**Aegis surface analyzed:** `libs/connectors/src/**` + `apps/workflow/src/consumers/connector-sync.consumer.ts` + the `ConnectorPushRequested` producers in `apps/invoice` and `apps/payroll`.
**Reference:** the ERP-integration reference (a "connect" service — a standalone Python/FastAPI + Celery ERP gateway). Reference names appear here **only for analysis**; they are not used in shipped Aegis code.

---

## 1. What the ERP-integration reference actually is

The reference is a **dedicated, separately-deployed service** whose entire job is to be the single hub through which many internal services talk to many ERPs (Oracle EBS/Fusion, Dynamics NAV, SAP ECC, Trimble, RentalMan, JDE, Delmiaworks, FuelMe, SFTP, and other ERP systems). It is **not** a library imported into the domain services — it has its own process, its own DB schema, its own Celery workers, its own Dockerfile/CI (`Dockerfile`, `.gitlab-ci.yml`, `celery_worker.py`), and it owns a dedicated Postgres role with explicit grants on its own tables (`README.md:104-174`).

Its proxy/gateway anatomy:

| Concern | Reference mechanism | Evidence |
|---|---|---|
| **Adapter per ERP** | One adapter class per ERP, selected by a factory keyed on `ERPNames` | `app/factories/adapter_factory.py:31-57` (`ADAPTERS` map + `AdapterFactory.get_adapter`) |
| **Transformer per (ERP × entity)** | Two-level factory: `transformer_map[erp][entity] → TransformerCls`, bidirectional (`ERP_TO_NORMALIZED` / `NORMALIZED_TO_ERP`) | `app/factories/transformer_factory.py:34-157` |
| **Registry** | The `ADAPTERS` / `transformer_map` dicts are the registries; a new ERP is a new map entry + adapter + transformer set | `adapter_factory.py:31`, `transformer_factory.py:35` |
| **Per-ERP auth / config** | Per-connection credentials persisted in a `Credentials` table, **encrypted at rest** (Fernet, `DB_ENCRYPTION_KEY`), fetched by `connection_id`; per-ERP quirks (ERP-specific client secrets, merge-vs-override on update) handled centrally | `app/services/credentials_manager.py:24-253`; `README.md:87-97` |
| **Token refresh** | On `AuthorizationException`, adapter `refresh_credentials()` → persist new tokens → rebuild adapter → retry | `orchestrators/erp_sync_orchestrator.py:656-678`; `app/services/credential_refresh_manager.py:12-48` |
| **Request routing (inbound)** | An **SQS consumer** parses S3 upload events, resolves `connection_id → ERP`, and routes to the right entity sync / status processor | `app/consumer/sqs.py:21-255` |
| **Idempotency / locking** | Postgres **advisory locks** keyed on the job reference guard concurrent push of the same record; pre-validation skips records already `SUCCESS`/`IN_PROGRESS` | `orchestrators/bill_sync_orchestrator.py:519-546` |
| **Retry / backoff** | `@retry((AuthorizationException, RetryException), max_attempts=3, initial_delay, delay_multiplier=2)` decorator on the fetch and create paths | `app/utils/decorators.py:7-45`; applied at `erp_sync_orchestrator.py:388`, `bill_sync_orchestrator.py:405` |
| **Sync-state table(s)** | Durable `SyncRecords` (per run: status, entities, resumable `meta` cursor, `task_id`, source=CRON/…) + `SyncStatuses` (per entity) + `ErpData` (raw payload audit) | `erp_sync_orchestrator.py:246-321`, `:178-215`; lifecycle enum `EntitySyncTypes` (SCHEDULED/FETCHING/FETCH_SUCCESS/FETCH_FAILED/PAUSED/RESUMED/CANCELLED/COMPLETED) |
| **Status callbacks / async polling** | The push is frequently **async at the ERP**: the connect service writes a `queued` record with a reference id, then **cron-polls** the ERP for terminal status and reconciles (`poll_bill`, attachment polling) | `app/tasks.py:132-159` (beat schedule, `*/15`), `:285-510` (the poll tasks) |
| **Webhooks / file callbacks** | Inbound status arrives as files moved to `completed`/`failed` S3 folders → SQS → `process_bill_status_update` | `app/consumer/sqs.py:172-231` |
| **Error normalization** | A typed exception hierarchy (`AuthorizationException`, `RetryException`, `UnrecoverableException`, `AttachmentExpiredException`, an ERP-specific account-period-closed exception) drives retry-vs-sideline; user-facing errors normalized via `format_error(IntegrationError.*)` | `bill_sync_orchestrator.py:8,419-425`; `export_order_sync_service.py:70-90` |
| **Sidelining / DLQ semantics** | "Sideline after N failures" + a `retry_bill_sync_for_stuck_jobs` reaper that finds rows stuck `>1h`, archives steps, marks `FAILED`, and re-drives | `app/tasks.py:558-683`; `export_order_sync_service.py:166` (TODO sideline after 5) |
| **Rate limiting** | Effectively via **scheduling**: each ERP's master-data sync runs on its own crontab window, and large fetches paginate in fixed batches (`fetch_by_pagination`, batch sizes 1000/200) | `app/tasks.py:78-131`; `erp_sync_orchestrator.py:432-450` |
| **Sync settings / gating** | Per-connection `SyncSettings` (master-data toggles, org allow/deny lists, blocked-day ranges, pause flags) consulted before every push | `bill_sync_orchestrator.py:113-205`; `credentials_manager.py:128-178` |

**Direction of data is bidirectional.** The ERP-integration reference both **pulls** master data ERP→app (`ERPSyncOrchestrator`) and **pushes** transactions app→ERP (`BillSyncOrchestrator`, `ExportOrderSyncService`). Aegis today implements only the **push** half.

---

## 2. What Aegis has today

Aegis implements the **push** half as a **library + event consumer**, not a service:

- **`@aegis/connectors` (library).** A clean adapter/strategy/factory decomposition that is faithful to the ERP-integration reference's *shape*:
  - `Connector` interface (`authenticate`/`pushTransaction`/`getStatus`/`healthCheck`) — `libs/connectors/src/connector.ts:42-48`.
  - `ConnectorRegistry` (factory keyed on `ConnectorKind`) — `registry.ts:6-24`.
  - `BaseConnector` enforcing idempotency + retry/backoff + audit logging, subclasses implement `doPush`/`doStatus` — `base-connector.ts:31-96`.
  - `Transformer` strategy (`IdentityTransformer`, `AbstractTransformer`) mapping domain entity → ERP payload, mirroring the ERP-integration reference's `*_bill_transformer` — `transformer.ts:19-62`.
  - Three **mock** connectors (LedgerOne, Finovo, AcctBridge) auto-registered at import — `index.ts:20-28`, `mock/ledger-one.ts`.
- **`apps/workflow/.../connector-sync.consumer.ts` (the consumer).** Subscribes to `ConnectorPushRequested`, rebuilds the producer's tenant context, fail-closed tenant assertion, idempotent push via the registry, best-effort audit of the outcome, and **relies on the bus's bounded retry → DLQ** for reliability — `connector-sync.consumer.ts:61-145`.
- **Producers stage the push as an event in the same transaction (transactional outbox).** Invoice approval (`apps/invoice/src/services/invoice.service.ts:286-301`, idempotencyKey = invoice id) and pay-run disbursement (`apps/payroll/src/services/pay-run.service.ts:262-282`, idempotencyKey = `runId:sha256(summary)`) emit `ConnectorPushRequested` rather than calling the ERP inline. The workflow rules engine can also emit it as a builtin action (`apps/workflow/src/engine/actions/builtin.ts:96-104`).

### What Aegis got RIGHT (reference-faithful)
1. **Adapter/strategy/factory split is correct** and arguably cleaner than the ERP-integration reference (interface-driven, one adapter per ERP, transformer as an explicit strategy).
2. **Push moved off the request path** onto the bus with retry → DLQ — this is the *modern* equivalent of the ERP-integration reference's Celery + stuck-job reaper, and is a genuine improvement over the ERP-integration reference's synchronous-with-advisory-lock approach.
3. **Idempotency is a first-class concept** (`PushRequest.idempotencyKey` required; producers supply stable keys; `BaseConnector` dedupes).
4. **Transactional outbox** guarantees the push request commits atomically with the business write — the ERP-integration reference has no equivalent and instead relies on the stuck-job reaper to recover lost work.

### Where Aegis DIVERGES from the ERP-integration reference (the gaps)
1. **Idempotency is in-memory only.** `BaseConnector.seen` is a process-local `Map` (`base-connector.ts:33-34`). Across worker restarts, multiple workflow replicas, or a Kafka rebalance, the same `idempotencyKey` **will** re-push to the ERP. The ERP-integration reference enforces this durably via advisory locks + a persisted `JobExternalIntegrations` status row. **This is the single most important production gap.**
2. **No persisted sync-state / log.** The enum declares `ConnectorConfigs` and `ConnectorSyncLog` table names (`libs/shared/enums/src/table-name.enum.ts:94-96`) but **no migration, model, or repository exists for either** (grep confirms only the enum + docs reference them). There is no Aegis equivalent of `SyncRecords`/`SyncStatuses`/`ErpData` — once the consumer logs and returns, the push outcome lives only in the append-only audit trail (best-effort, `connector-sync.consumer.ts:96-127`) and Kafka.
3. **No status callbacks / async reconciliation.** `getStatus`/`doStatus` exist on the interface but are **never called by any consumer** (grep: the only `getStatus` callers are in the unrelated approvals lib). The ERP-integration reference's defining gateway behavior — write `queued`, then cron-poll the ERP and reconcile to a terminal status (`app/tasks.py:285-510`) — has no counterpart. Aegis assumes every push is synchronously terminal (`status: 'synced'`), which the mock connectors satisfy but a real async ERP (Oracle EBS, Trimble) would not.
4. **No per-ERP auth/config store.** `configFor(kind, tenantId)` returns `{ kind, tenantId }` with no credentials, baseUrl, or settings (`connector-sync.consumer.ts:41-43`); `ConnectorConfig.credentialsRef` is a documented-but-unresolved field (`connector.ts:3-11`). The ERP-integration reference's encrypted per-connection `Credentials` table + token-refresh-on-401 loop has no counterpart yet.
5. **DLQ is generic, not connector-aware.** Reliability is delegated wholesale to the bus's retry/DLQ. There is no connector-specific notion of *retryable vs. unrecoverable* (the ERP-integration reference's `RetryException` vs `UnrecoverableException` distinction), so a permanently-bad payload burns the full retry budget before dead-lettering, and a parked envelope has no sync-state row to make it discoverable/re-drivable by an operator.
6. **No rate limiting / scheduling per ERP.** Acceptable while connectors are mocks and push is event-driven (naturally smoothed), but real ERPs impose request quotas the ERP-integration reference respects via per-ERP crontab windows + fixed pagination batches.

---

## 3. RECOMMENDATION — keep the lib + consumer now; design the seam for a service later

**Do NOT elevate `@aegis/connectors` into a dedicated `connector-gateway` service yet.** Keep the **library + `ConnectorPushRequested` consumer**, and instead close the durability gaps (§4) inside that shape. Rationale for our scale and stage:

**Pros of staying lib + consumer (recommended now):**
- The ERP-integration reference's *reason* for being a separate service — many heterogeneous internal services sharing one ERP integration surface, with its own DB role and deploy cadence — **does not yet apply**: only `invoice` and `payroll` (and the rules engine) push, and they already share the library + one consumer. We have the consolidation benefit without a network hop.
- The event-driven push (outbox → Kafka → consumer with retry/DLQ) already delivers the asynchrony, isolation-from-request-path, and retriability that the ERP-integration reference needed a Celery service to get. Splitting out a service now adds an RPC boundary, a second deployable, and cross-service auth for **zero** capability gain.
- The interface (`Connector`) and the event contract (`ConnectorPushRequested`) are the natural service boundary: if/when extraction is warranted, the consumer body lifts into a service almost verbatim and producers keep emitting the same event.

**Cons / when to revisit (extract to a service when ANY hold):**
- A **third+ business domain** needs ERP push, or connectors need an independent deploy/scaling cadence from the workflow worker.
- Real ERP credentials + OAuth refresh loops need an isolated security boundary (a service owning the encrypted credential store, à la the ERP-integration reference's dedicated DB role) rather than every workflow-worker replica holding ERP secrets.
- ERP **pull** (master-data sync ERP→app) is added — that workload is long-running, paginated, scheduled, and resumable (the ERP-integration reference `ERPSyncOrchestrator`), and is a poor fit for a short-lived event consumer. *Pulling* is the strongest future trigger for a dedicated service.
- Connector-specific rate limiting / global concurrency control across tenants is required (best owned by a single service, not N consumer replicas).

**Net:** the lib+consumer is the right altitude **for the push half at current scale**; the work to do now is durability, not extraction. Treat the persisted sync-state + per-ERP config store (§4 items 1, 2, 4) as the pieces that must be service-extractable later — put them behind repositories in `@aegis/connectors` (or a thin `@aegis/connector-store`) so a future `connector-gateway` can adopt them unchanged.

---

## 4. Reference-faithful improvements to implement (with severity)

| # | Improvement | Severity | Recommendation |
|---|---|---|---|
| 1 | **Durable idempotency / sync-state table** (`connector_sync_log`): persist `(tenant_id, idempotency_key, connector_kind, entity, external_id, status, attempt, last_error, payload_hash, created_at, updated_at)`. `BaseConnector.pushTransaction` should consult/insert this row (unique on `(tenant_id, idempotency_key)`) **instead of** the in-memory `Map`. Mirrors the ERP-integration reference `SyncRecords`/`JobExternalIntegrations` + advisory-lock dedupe. | **Critical** | The in-memory `seen` Map (`base-connector.ts:33`) does NOT survive restarts or span replicas, so the same invoice/pay-run will double-push to a real ERP under at-least-once delivery. The `ConnectorSyncLog` table name is already reserved in the enum but unbacked. Build this first. |
| 2 | **Per-ERP auth/config store** (`connector_configs`): per-tenant row with `kind`, `base_url`, `credentials_ref` (resolved via the secret proxy), `settings`, `active`. Replace the stub `configFor()` (`connector-sync.consumer.ts:41-43`) with a repository load. Add an `authenticate()` + **token-refresh-on-401** loop (the ERP-integration reference `CredentialRefreshManager`, `erp_sync_orchestrator.py:656-678`). | **High** | The table name is reserved but unbacked; `ConnectorConfig.credentialsRef` is documented but never resolved. Required before ANY real (non-mock) ERP can be added; keep encryption-at-rest semantics from the ERP-integration reference (`README.md:87-97`). |
| 3 | **Status callbacks / async reconciliation.** Add a scheduled status-poll path that drives `getStatus`/`doStatus` (today never called) for sync-log rows in a non-terminal state (`queued`/`in_progress`), reconciling to terminal status — the ERP-integration reference's `trigger_fetch_async_job_statuses*` cron (`app/tasks.py:132-159, 285-510`). Optionally accept inbound ERP webhooks to short-circuit the poll. | **High** | Real ERPs (Oracle EBS, Trimble) accept-then-process asynchronously; Aegis currently assumes every push is synchronously terminal (`SyncState 'synced'`). Without reconciliation, a `queued` push is never resolved. Depends on #1 (needs the sync-state row to poll). |
| 4 | **Connector-aware retry/backoff + DLQ semantics.** Introduce a typed `RetryableError` vs `UnrecoverableError` distinction (the ERP-integration reference `RetryException`/`UnrecoverableException`) so the consumer fast-fails permanent errors (bad payload, ERP "period closed") to the DLQ without exhausting the retry budget, and parks them as a `status='error'` sync-log row an operator can re-drive — the ERP-integration reference's `retry_bill_sync_for_stuck_jobs` reaper (`app/tasks.py:558-683`). `BaseConnector.withRetry` (`base-connector.ts:12-25`) currently retries everything blindly. | **Medium** | The generic bus retry/DLQ works but is coarse; a permanently-bad payload wastes the full retry budget and a dead-lettered envelope has no queryable sync-state. Layer onto #1/#2. |
| 5 | **Per-ERP rate limiting / concurrency control.** Add a per-(tenant,kind) token-bucket or max-in-flight guard before `doPush`, plus pagination/batch limits for the future pull path (the ERP-integration reference `fetch_by_pagination`, per-ERP crontab windows). | **Low (now) / High (at real-ERP scale)** | Not needed while connectors are mocks and push is naturally smoothed by the event stream; becomes important the moment a real quota-limited ERP is onboarded. |
| 6 | **Make the audit-of-outcome path not the only durable record.** Today the only persisted trace of a push is the **best-effort** audit write (`connector-sync.consumer.ts:96-127`), which is intentionally allowed to fail silently. Once #1 lands, the sync-log row becomes the source of truth and audit stays advisory. | **Medium** | Folds into #1 — call out so the sync-state table, not the audit trail, becomes the durable record of push state. |

---

## 5. Bottom line

Aegis **follows the ERP-integration reference's proxy *shape* faithfully** at the code-structure level (adapter / strategy / factory / registry, idempotency-keyed push, transformer-per-ERP) and actually **improves on it** by moving the push off the request path onto a transactional-outbox + Kafka pipeline with retry/DLQ. What it has **not yet built** is the ERP-integration reference's *durability surface*: a persisted sync-state/idempotency store, a per-ERP encrypted credential/config store, and async status reconciliation — all three are stubbed or enum-reserved but unbacked. Keep the library + consumer (extraction is premature for the push-only, two-producer reality), and spend the effort on the durable sync-state table (Critical) and per-ERP config/auth (High), designed behind repositories so a future `connector-gateway` service — most likely triggered by adding ERP **pull** — can adopt them unchanged.
