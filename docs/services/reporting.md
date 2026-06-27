# reporting — Service Contract

> The **read side** of Aegis. `reporting` is a **CQRS-lite** service: the seven
> transactional services own the write model; `reporting` maintains a
> read-optimized projection of their data and serves declarative reports against
> it. It never reaches into another service's tables and it never bypasses
> tenant isolation or access control — RLS guards every reporting row and a
> per-role column policy masks sensitive fields (notably **payroll**) *before*
> a query is ever compiled.
>
> **Authoritative spec:** [`../../SPEC.md`](../../SPEC.md) §0 (service table),
> §2.5 (per-service access-control highlights), §5 (data model — Reporting),
> §8 Phase 5, §10 (amendments).
> Related docs: [`../03-access-control-model.md`](../03-access-control-model.md) ·
> [`../04-multi-tenancy.md`](../04-multi-tenancy.md) ·
> [`../06-service-to-service.md`](../06-service-to-service.md) ·
> [`../07-data-models.md`](../07-data-models.md) ·
> [`../08-api-conventions.md`](../08-api-conventions.md) ·
> siblings: [`payroll.md`](payroll.md) · [`expense.md`](expense.md) ·
> [`invoice.md`](invoice.md) · [`workflow.md`](workflow.md).

---

## 1. Responsibility

`reporting` answers analytical questions that span more than one business
service — *"total approved expenses by department this quarter"*, *"invoice
duplicate rate by vendor"*, *"payroll disbursement summary for the last pay
run"* — without forcing the transactional services to carry query load or to
expose their internals.

It owns four things:

1. **Read models** — denormalized **fact tables** (`fact_expense`,
   `fact_invoice`, `fact_payroll`, `fact_approval`) + shared **dimensions**
   (`dim_user`, `dim_department`, `dim_vendor`, `dim_date`), fed from the source
   services over events, plus **materialized rollups** (`mv_*`) for hot
   aggregations.
2. **Declarative report definitions** — `report_definitions` describe *measures,
   dimensions, filters, and grain* as data; a compiler turns a definition +
   caller access-scope into a parameterized, RLS-respecting query. No raw SQL is
   accepted from clients.
3. **Scheduling & runs** — `report_schedules` (cron + delivery) and
   `report_runs` model asynchronous execution; a run is an artifact-producing
   job, not a synchronous request.
4. **Export & delivery** — CSV / XLSX / PDF rendered by BullMQ workers to object
   storage, delivered as short-lived **signed URLs**.

What `reporting` explicitly does **not** do:

- It does **not** write to any business domain — it is read-only with respect to
  the rest of the platform; the only tables it mutates are its own read models,
  definitions, schedules, and runs.
- It does **not** re-derive authority. It consumes already-authorized domain
  events and re-checks the *reader's* permission at query time via the PDP — it
  never reconstructs *who could have created* a source record.
- It does **not** hold OLTP-grade freshness. The read model is **eventually
  consistent**; every report carries an explicit **as-of** timestamp (see §10).

---

## Local Development

For an engineer extending **this** service. `reporting` is the read side: it
binds Postgres (read model + control tables), Redis (result cache), and may call
peer services over HTTP — but it does **not** connect to Kafka and runs no worker
(`bootstrap.ts`: *"read-mostly and does not publish, so there is no event bus to
stop"*). It serves HTTP on **port 4004**.

### Prerequisites

- **Node 22** + **npm**, and **Docker** (for the infra it depends on).
- From the repo root: `npm ci` (installs the Nx workspace once).

### Bring up the infra

`reporting` needs **Postgres** and **Redis** at minimum (the migrate step also
spins **Kafka**, which the broader stack uses — `reporting` itself never dials
it). Two options:

- **(a) Whole stack**, then develop against it:

  ```bash
  bash scripts/setup.sh
  ```

- **(b) Just the infra** you need, then run migrations once:

  ```bash
  docker compose -f docker-compose.all.yml up -d postgres redis kafka
  docker compose -f docker-compose.all.yml run --rm migrate
  ```

Both publish the container ports to the host: Postgres `5432`, Redis `6379`,
Kafka `9092`.

### Run this service with hot-reload

```bash
npx nx serve reporting
```

`serve` uses the `@nx/js:node` executor against the `reporting:build` output, so
saves rebuild and restart.

> **Gotcha — the committed `apps/reporting/.env` uses Docker-network hostnames.**
> Values like `postgres:5432`, `redis:6379`, `kafka:9092`, and inter-service URLs
> such as `http://user-management:4001` / `http://gateway:4000` only resolve
> *inside* the compose network. When you run `nx serve` on the host, those names
> do not resolve — point them at the docker-published host ports instead (a local
> env override that your shell/`.env.local` layers on top of the committed file):
>
> ```bash
> DATABASE_URL=postgres://aegis_app:aegis_app_pw@127.0.0.1:5432/aegis
> REDIS_URL=redis://127.0.0.1:6379
> # inter-service URLs reporting may call via @aegis/service-core's http-client:
> GATEWAY_URL=http://127.0.0.1:4000
> USER_MANAGEMENT_URL=http://127.0.0.1:4001
> EXPENSE_URL=http://127.0.0.1:4002
> PAYROLL_URL=http://127.0.0.1:4003
> REPORTING_URL=http://127.0.0.1:4004
> WORKFLOW_URL=http://127.0.0.1:4005
> NOTIFICATION_URL=http://127.0.0.1:4006
> INVOICE_URL=http://127.0.0.1:4007
> ```
>
> The vars **this** service actually reads that need the localhost rewrite are:
> `DATABASE_URL`, `REDIS_URL`, and the inter-service `*_URL` entries above (only
> the peers you actually exercise need to be reachable). `KAFKA_BROKERS` does
> **not** need rewriting — `reporting` never connects to Kafka. `JWKS_URL` is a
> documented seam; the demo PEP validates the user token with the shared
> `AUTH_JWT_SECRET` (HS256), so token verification works against the committed
> dummy secret without a running user-management.

### Verify it's up

```bash
curl localhost:4004/health
```

`/health` is excluded from the context/auth band, so it answers without a token.
In normal use the service is reached **through the gateway** —
`http://localhost:4000/reporting/v1/...` — and each service re-validates auth via
its own PEP, so a direct `:4004` call still requires a valid bearer token on the
`/v1/*` routes.

### Runtime dependencies

- **Postgres** (`DATABASE_URL`, **required** per `bootstrap.ts` — read model +
  `report_definitions`/`report_schedules`/`report_runs`/`report_access_policies`,
  all RLS-guarded; connects as the non-owner `aegis_app` role).
- **Redis** (`REDIS_URL`) — the access-scope-keyed result cache (`CacheAdapter`).
- **user-management** — only as the **token-issuing authority**; the PEP verifies
  the user JWT with `AUTH_JWT_SECRET` locally (HS256), and `JWKS_URL` is reserved
  for the asymmetric/JWKS path. No live call is required to validate a token.
- **Peer services** over HTTP via the `@aegis/service-core` http-client (signed
  internal token + origin gate) for any cross-service enrichment.
- **No Kafka, no worker.** `PROCESS_TYPE=api` only; the read model is populated
  from events in the production design, but this service neither produces nor
  consumes topics at runtime today (the async run path is the BullMQ/worker
  upgrade seam, not wired here).

### Test & build

```bash
npx nx test reporting     # Jest unit tests
npx nx build reporting    # production build — runs the prod type-check (tsc)
```

`build` uses the `@nx/webpack:webpack` executor with `compiler: 'tsc'`, so a
production build fails on type errors — run it before pushing.

---

## 2. CQRS-lite — and the explicit graduation trigger

Aegis adopts **CQRS-lite**, not full CQRS. We do not split the *write* side of
the business services; we add a read-optimized *projection* on the read side,
because reporting is overwhelmingly read-heavy and almost never needs a
write-side command model.

**v1 (this document):** the read store is **PostgreSQL** — a **read replica** of
the platform database plus **materialized views / rollup tables** maintained in
the `reporting` schema. No new datastore, no Kafka, no CDC. This fits the locked
stack (PostgreSQL + RLS + Sequelize + Redis/BullMQ, [`../../SPEC.md`](../../SPEC.md)
§4) and ships fast.

```mermaid
graph LR
  subgraph "Write side (owners)"
    EX[expense]
    IN[invoice]
    PR[payroll]
    WF[workflow]
  end
  subgraph "events"
    OB[(outbox + topic registry)]
  end
  subgraph "reporting (read side)"
    PROJ[projection<br/>consumers]
    FACTS[(fact_* + dim_*<br/>+ mv_* rollups)]
    API[report API + compiler]
  end
  EX -- ExpenseApproved --> OB
  IN -- InvoiceIssued --> OB
  PR -- PayRunCompleted --> OB
  WF -- ApprovalResolved --> OB
  OB --> PROJ --> FACTS
  API --> FACTS
```

**Graduation trigger (documented, deliberate).** Stay on Postgres replica + MVs
until **one** of the following holds, at which point we graduate the read store
to **ClickHouse fed by Debezium CDC over `@aegis/events`** (the fact/dimension
model and the report-definition compiler are designed to survive that swap —
only the physical store changes):

| Signal | v1 ceiling | Graduate when… |
|---|---|---|
| p95 interactive query latency | ≤ 300 ms from MVs | sustained > 1 s despite rollups |
| Largest fact table | ≲ 50 M rows | > 100 M rows / tenant-cohort |
| Concurrent live-dashboard readers | tens | hundreds, sub-second required |
| MV refresh window | minutes, incremental | refresh can't keep cadence |

Until then, ClickHouse/CDC is **deferred** — introducing it early would add an
operational broker and a second store for no measurable benefit.

---

## 3. Cross-service aggregation via events + outbox

`reporting` builds its fact tables by **consuming domain events**, never by
querying a peer service's database. Each source service writes its event into an
**outbox** table in the *same transaction* as the domain change (so there is no
dual-write race), and `@aegis/events` delivers it to `reporting`'s projection
consumers, which **upsert** the denormalized read model.

```mermaid
sequenceDiagram
    autonumber
    participant SVC as expense (owner)
    participant DB as expense DB
    participant BUS as events bus
    participant RPT as reporting projection
    participant FACT as fact_expense

    SVC->>DB: BEGIN
    SVC->>DB: UPDATE expense_reports (approve)
    SVC->>DB: INSERT outbox (ExpenseApproved, tenant_id, payload)
    SVC->>DB: COMMIT
    BUS-->>RPT: deliver ExpenseApproved (X-Correlation-Id propagated)
    RPT->>FACT: SET LOCAL app.current_tenant = <tenant>
    RPT->>FACT: UPSERT fact_expense (idempotent on business key)
    RPT-->>BUS: ack
```

Properties that matter:

- **Idempotent projection.** Every fact upsert keys on a stable business key
  (e.g. `(tenant_id, expense_report_id)`), so re-delivery is safe — events are
  at-least-once.
- **Tenant carried on the event.** The event header carries `tenantId`; the
  consumer opens its transaction with `SET LOCAL app.current_tenant` (§4) so the
  *write into the read model* is itself RLS-guarded.
- **Correlation preserved.** `X-Correlation-Id` (the business-request id minted
  at the gateway, [`../06-service-to-service.md`](../06-service-to-service.md))
  rides the event header into the projection, so a report row can be traced back
  to the originating operation. There is no `X-Trend`/`X-Tracker` header.
- **No cross-service joins at query time.** Facts are pre-joined to their
  dimensions during projection; a report is answered from `reporting`'s own
  schema alone.

> When v1 graduates (§2), the only change here is the *transport*: Debezium reads
> the same outbox/WAL and streams to ClickHouse. The projection contract — events
> in, denormalized facts out — is unchanged.

---

## 4. Tenant isolation — RLS on every reporting table

Reporting is the highest-leakage surface in the platform: one mis-scoped
aggregate can expose another tenant's totals. So **every** reporting
table — facts, dimensions, definitions, schedules, runs, access policies — is
tenant-scoped and RLS-guarded exactly as specified in
[`../04-multi-tenancy.md`](../04-multi-tenancy.md):

- `tenant_id UUID NOT NULL` on every row.
- `ENABLE` **and** `FORCE ROW LEVEL SECURITY` (so even the table owner is
  subject to the policy).
- A **`RESTRICTIVE`** policy keyed on the session variable, so it combines with
  `AND` and cannot be `OR`-ed away by a permissive policy.
- The `reporting` service connects as a **non-owner role without `BYPASSRLS`**.
- Tenant is set with **`SET LOCAL`** *inside the transaction* — safe under a
  transaction-pooled connection — sourced from the request context
  (`@aegis/service-core`), never from the request body.

```sql
-- Applied to every reporting table (fact_*, dim_*, report_*).
ALTER TABLE fact_expense ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_expense FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_fact_expense ON fact_expense
  AS RESTRICTIVE
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
```

```ts
// libs/db — every reporting query (read OR projection write) runs inside a txn
// that pins the tenant first. RLS is the backstop; the predicate is the belt.
await db.withTenantTransaction(ctx.tenantId, async (tx) => {
  await tx.query('SET LOCAL app.current_tenant = $1', [ctx.tenantId]);
  return reportRepository.runCompiledQuery(compiled, tx);
});
```

**Never bypass RLS.** There is no "admin reporting" code path that drops the
tenant predicate. A platform-operator report is itself a tenant-scoped run; a
genuine cross-tenant operational view is a separate, audited capability outside
this service.

---

## 5. Row- and column-level access control

Tenant isolation answers *"which tenant?"*. Within a tenant, `reporting` applies
**two further layers**, both driven by `report_access_policies` and resolved
through the PDP ([`../03-access-control-model.md`](../03-access-control-model.md)).

### 5.1 Row level — scope predicates

A reader's **row-level scope** (`AllRecords | OwnAndTeam | OwnOnly`, plus
team/hierarchy membership) is compiled into an additional `WHERE` predicate over
the fact table and is backstopped by per-user RLS where a policy references
`app.current_user`. An employee sees only their own expense facts; a manager
sees their cost-center; a finance admin sees the whole tenant. The predicate is
derived from the PDP verdict's **obligations**, never trusted from the client.

### 5.2 Column level — masking in the definition compiler

Column visibility is enforced **before SQL is generated**, in the
report-definition compiler, using the role's policy row:

```sql
-- report_access_policies (tenant-scoped, RLS-guarded)
-- role        | allowed_columns          | masked_columns        | row_filter_expr
-- ------------+--------------------------+-----------------------+--------------------
-- 'analyst'   | {amount,status,dept}     | {}                    | NULL
-- 'manager'   | {amount,status,dept}     | {}                    | cost_center = :cc
-- 'hr_viewer' | {gross,net,status,dept}  | {bank_account,nat_id} | NULL
```

The compiler:

1. Loads the caller's `report_access_policy` for the requested definition.
2. **Intersects** the definition's requested measures/dimensions with
   `allowed_columns` — a column the role may not see is **dropped from the SELECT
   list entirely**, not filtered after the fact.
3. Applies **masking** to `masked_columns` — sensitive **payroll** fields
   (salary, bank account, national id) are projected as a redaction
   (`'••••' AS bank_account`) or omitted, mirroring payroll's field-level RBAC in
   [`payroll.md`](payroll.md). The raw values never enter the query plan, the
   cache, or an export artifact.
4. Injects the row-level `row_filter_expr` (§5.1) into the `WHERE`.

```ts
// access-control obligation → compiler input
const policy = await pip.reportAccessPolicy(ctx, definition.id);     // PIP
const verdict = pdp.decide(principal, 'report.run', def);  // PDP, fail-closed
if (!verdict.allow) throw ErrorUtils.forbidden(verdict.reason);

const safeMeasures = intersect(def.measures, policy.allowedColumns);
const maskedExprs  = maskColumns(def.dimensions, policy.maskedColumns);
const rowFilter    = compileScope(verdict.obligations.scope, ctx);   // OwnOnly / OwnAndTeam / All
const compiled     = compileToSql({ ...def, measures: safeMeasures, maskedExprs, rowFilter });
```

> **Client cannot widen its own view.** Asking for a masked column simply yields
> a masked/absent column — the request is not an authorization boundary; the
> policy is. This is the reporting analogue of payroll's "never trust the client
> to omit columns".

### 5.3 Access-scope is part of every cache key

Because the *same definition* yields *different rows/columns* per reader, the
**effective access-scope is a mandatory component of every cache key**. Omitting
it would let one reader serve another reader's rows from cache.

```
resultCacheKey = sha256(
  tenantId
  + ':' + reportDefinitionId
  + ':' + accessScopeHash      // role + row-scope + allowed/masked columns
  + ':' + paramsHash
  + ':' + readModelVersion     // bumped on MV refresh → freshness-correct
)
```

---

## 6. Three-tier caching

```mermaid
graph TD
  Q[report run] --> T1{pre-agg / MV hit?}
  T1 -- yes --> A[serve from mv_* rollup]
  T1 -- no --> T2{Redis result cache hit?<br/>key includes accessScopeHash}
  T2 -- yes --> B[serve cached result]
  T2 -- no --> C[compile + query read replica]
  C --> WRITE[write Redis result cache]
  WRITE --> B
  EXP[export artifact] --> T3[content-addressed<br/>object-storage / CDN cache]
```

1. **Pre-aggregation / materialized-view tier** — the big lever. Hot rollups
   (`mv_expense_by_dept_month`, `mv_invoice_by_vendor_month`, …) are partitioned
   **by time** and refreshed **incrementally** (only recent partitions) on a
   BullMQ cron. The compiler transparently rewrites a matching definition onto
   the rollup instead of scanning raw facts.
2. **Redis result cache** — the compiled query result, keyed by the
   **access-scope-aware** hash in §5.3. TTL is aligned to the MV refresh cadence;
   `readModelVersion` in the key gives correct invalidation when a rollup
   refreshes.
3. **Content-addressed export cache** — rendered CSV/XLSX/PDF artifacts are
   immutable and content-addressed in object storage; identical re-runs return
   the existing signed URL without re-rendering.

A **"recompute now"** path bypasses tiers 1–2 (and re-checks the PDP) so finance
users can force a fresh read of the latest projection.

---

## 7. Data model

All tables carry `tenant_id NOT NULL` + RLS (§4). UUID v4 PKs, money in integer
minor units, `created_at`/`updated_at`, `underscored: true` per
[`../08-api-conventions.md`](../08-api-conventions.md). Full schema lives in
[`../07-data-models.md`](../07-data-models.md) (Reporting section).

### 7.1 Read models — facts, dimensions, rollups

| Table | Shape | Fed from |
|---|---|---|
| `fact_expense` | `tenant_id`, `expense_report_id`, `dim_user_id`, `dim_department_id`, `amount_minor`, `status`, `incurred_on`, `approved_at` | `expense` events |
| `fact_invoice` | `tenant_id`, `invoice_id`, `dim_vendor_id`, `amount_minor`, `status`, `is_duplicate`, `issued_on` | `invoice` events (header-level) |
| `fact_payroll` | `tenant_id`, `pay_run_id`, `dim_user_id`, `gross_minor`, `net_minor`, `status`, `disbursed_at` | `payroll` events |
| `fact_approval` | `tenant_id`, `record_type`, `record_id`, `approver_user_id`, `decision`, `decided_at` | `workflow`/approval events |
| `dim_user` · `dim_department` · `dim_vendor` · `dim_date` | conformed dimensions | identity + domain events |
| `mv_*` rollups | partitioned, incrementally refreshed | derived from facts |

> Consistent with [`../../SPEC.md`](../../SPEC.md) §10: **invoice facts are
> header-level** (no line items, no GL codes) — `is_duplicate` and amount/variance
> reflect duplicate-detection + threshold checks, not line-level matching.

### 7.2 Reporting control tables

```sql
CREATE TABLE report_definitions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  spec_json           JSONB NOT NULL,   -- { measures[], dimensions[], filters[], grain }
  required_permission TEXT NOT NULL,    -- e.g. 'report.run'
  is_system           BOOLEAN NOT NULL DEFAULT false,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report_schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  definition_id UUID NOT NULL REFERENCES report_definitions(id),
  cron          TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  delivery_json JSONB NOT NULL,         -- { format, targets[] (email/webhook) }
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  definition_id UUID NOT NULL REFERENCES report_definitions(id),
  requested_by  UUID NOT NULL,
  params_json   JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'queued',   -- queued|running|succeeded|failed
  as_of         TIMESTAMPTZ,                       -- read-model freshness (§10)
  artifact_url  TEXT,                              -- signed URL once succeeded
  error         JSONB,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report_access_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  role            TEXT NOT NULL,
  allowed_columns TEXT[] NOT NULL DEFAULT '{}',
  masked_columns  TEXT[] NOT NULL DEFAULT '{}',
  row_filter_expr TEXT,                            -- compiled into WHERE (§5.1)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

A `report_definitions.spec_json` is small and declarative:

```json
{
  "measures":   [{ "name": "total", "agg": "sum", "field": "amount_minor" }],
  "dimensions": [{ "name": "department", "field": "dim_department_id" },
                 { "name": "month", "field": "incurred_on", "grain": "month" }],
  "filters":    [{ "field": "status", "op": "eq", "value": "approved" }],
  "grain":      "month",
  "source":     "fact_expense"
}
```

---

## 8. Endpoints

Every route is wrapped `authenticate → authorize(permission) → handler`
([`../08-api-conventions.md`](../08-api-conventions.md)); `tenantId`/`userId`
come from the validated request context, never the body. Lists return
`{ data, meta: { total, page, pageSize } }`; errors use the standard envelope.

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /v1/report-definitions` | `report.view` | List definitions (tenant-scoped). |
| `POST /v1/report-definitions` | `report.define` | Create a declarative definition. |
| `GET /v1/report-runs` | `report.view` | Paged run history; optional `definitionId` and `status` filters. |
| `POST /v1/report-runs` | `report.run` | **Async** execute → `202` + `runId`. |
| `GET /v1/report-runs/{id}` | `report.view` | Run status + artifact URL once succeeded. |
| `GET /v1/report-runs/{id}/export` | `report.view` | Signed artifact URL for a succeeded run; `409` until ready. |
| `GET /v1/report-schedules` | `report.view` | Paged recurring-run schedules; optional `definitionId` and `enabled` filters. |
| `POST /v1/report-schedules` | `report.define` | Create a recurring run schedule. |
| `PATCH /v1/report-schedules/{id}` | `report.define` | Update `cron`, `timezone`, and/or `enabled`. |
| `DELETE /v1/report-schedules/{id}` | `report.define` | Delete a schedule. |

Definition update/delete, streamed run-data pages, and multi-format export rendering remain
documented upgrade seams. The current demo settles runs synchronously with a stub artifact URL; the
production path hands the run to BullMQ workers.

### 8.1 Async run — request/response

```http
POST /v1/report-runs HTTP/1.1
X-Tenant-Id: 8f1c…   X-Correlation-Id: 2b90…
Authorization: Bearer <jwt>
Content-Type: application/json

{ "definitionId": "a1b2…", "params": { "quarter": "2026-Q2" } }
```

```http
HTTP/1.1 202 Accepted
Location: /v1/report-runs/3c4d…

{ "data": { "runId": "3c4d…", "status": "queued" } }
```

```http
GET /v1/report-runs/3c4d… HTTP/1.1   →   200 OK
{ "data": { "runId": "3c4d…", "status": "succeeded",
            "artifactUrl": "https://obj.aegis…/exports/3c4d…?X-Signed=…&exp=…" } }
```

---

## 9. Async run flow

```mermaid
sequenceDiagram
    autonumber
    actor U as Reader (JWT)
    participant API as reporting API (PEP)
    participant PDP as access-control (PDP)
    participant Q as BullMQ (Redis)
    participant W as export worker
    participant RR as read replica + MVs
    participant OS as object storage
    participant N as notification

    U->>API: POST /v1/report-runs {definitionId, params}
    API->>PDP: decide(principal, report.run, definition)
    PDP-->>API: allow + obligations(scope, masked/allowed cols)
    API->>RR: INSERT report_runs(status='queued') [SET LOCAL tenant]
    API->>Q: enqueue run job (tenantId, runId, accessScope)
    API-->>U: 202 Accepted + runId
    note over U,API: client polls GET /v1/report-runs/{id}

    Q-->>W: dequeue job
    W->>RR: SET LOCAL app.current_tenant; run compiled query (RLS + masking)
    RR-->>W: rows + as_of (read-model freshness)
    W->>W: render CSV / XLSX / PDF
    W->>OS: PUT artifact (content-addressed)
    W->>RR: UPDATE report_runs(status='succeeded', as_of, artifact_url=signed)
    W->>N: emit ReportReady event (delivery targets)
    U->>API: GET /v1/report-runs/{id} → signed URL
    U->>OS: GET artifact via signed URL
```

Failure path: a worker exception sets `report_runs.status='failed'` with a typed
`error` envelope; BullMQ retries with backoff up to the configured limit; a
terminal failure emits a `ReportFailed` event to `notification`.

---

## 10. Freshness — the as-of contract

Because the read model is **eventually consistent**, every run records and every
response surfaces an **`as_of`** timestamp: the watermark of the read model at
query time (the latest projected event the facts reflect). Finance users see, on
the report itself, *"data as of 2026-06-26 11:58 UTC"* so they know it may lag
the transactional source. The **"recompute now"** path (§6) lets a user bypass
caches and re-read the freshest projection; reconciliation against the source
service is then a matter of comparing `as_of` to the source's own clock.

---

## 11. Definition of Done

`reporting` is done (per [`../../AGENTS.md`](../../AGENTS.md) §8) only when it:
shares `@aegis/service-core` + `@aegis/access-control`; enforces tenant **RLS** on
every reporting table; applies **column masking** for sensitive fields and an
**access-scope-keyed** result cache; has a PEP `authorize(...)` on every route;
emits audit entries on definition/schedule writes and on every run; ships with
unit tests above the coverage gate; and keeps this doc in sync with
[`../../SPEC.md`](../../SPEC.md).
