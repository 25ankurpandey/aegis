# Aegis — Architecture

> **Start here.** This is the single entry point a new engineer reads first. It ties together the five
> deep-dive chapters under [`docs/architecture/`](./architecture/), gives you the whole-system picture
> in one diagram, and points you at the rest of the docs. Every chapter it links is traced to real
> code; when a chapter and the code disagree, the code wins — fix the drift.

---

## What is Aegis

**Aegis is an enterprise, multi-tenant, microservices access-control platform** — a working reference
for getting authorization *right* across many services and many tenants at once. It is an Nx monorepo:
a **gateway** in front of **eight business services** plus a **cli**, all sharing one PostgreSQL
database with **Row-Level Security (RLS)** for database-enforced tenant isolation, **Casbin** (RBAC
with a tenant domain + ABAC conditions) for centralized authorization, **Redis** for cache and
cross-pod policy-reload fan-out, and **Kafka** for asynchronous cross-service domain events delivered
through a **transactional outbox**. On top of that substrate it demonstrates real finance workflows —
expense, invoice, payroll (maker-checker), a rules-as-data workflow engine, reporting, and
notification — with tamper-evident hash-chained auditing throughout. It is a **microservices
deployment**: each service builds its **own container image** from one shared `Dockerfile.service`,
and `PROCESS_TYPE` (api / worker / migration) selects the runtime role — so a service's api and its
worker run byte-identical bytes, while migrations run as a one-shot job from the `cli` image.

---

## Master system diagram

The whole system is one mental model, but a single flowchart that shows every edge at once is
unreadable. Below it is split into **five focused views**, each independently legible: the
north-south edge, the data plane, async eventing, the Casbin policy-reload bus, and the
`PROCESS_TYPE` pod roles. Read them in order for the full picture.

### (a) Edge — north-south request path

*Client always enters through the gateway, which proxies (but does not authorize) to the owning API service.*

```mermaid
flowchart TB
  client([Client / CLI])
  gw["gateway :4000<br/>mint X-Correlation-Id<br/>validate ctx headers<br/>reverse proxy (no authz)"]

  subgraph api["API pods — PROCESS_TYPE=api"]
    um["user-management :4001<br/>IdP + PAP"]
    exp["expense :4002"]
    pay["payroll :4003"]
    rep["reporting :4004"]
    wf["workflow :4005"]
    notif["notification :4006"]
    inv["invoice :4007"]
  end

  client -->|"HTTPS /&lt;svc&gt;/..."| gw
  gw -->|"forward + ctx headers + Bearer"| api
```

### (b) Data plane — every service talks to one Postgres (RLS) + Redis

*All API and worker pods reach the same Postgres through `withTenantTransaction` (RLS enforced); Redis is cache + idempotency.*

```mermaid
flowchart TB
  subgraph pods["API + worker pods"]
    apis["7 API services<br/>(user-management … invoice)"]
    workers["3 workers<br/>(expense / workflow / notification)"]
  end

  pg[("PostgreSQL<br/>single DB + RLS<br/>role aegis_app NOBYPASSRLS")]
  redis[("Redis<br/>cache + idempotency")]

  apis -->|"withTenantTransaction<br/>SET LOCAL app.current_tenant"| pg
  workers -->|"withTenantTransaction"| pg
  apis -.->|"cache / idempotency"| redis
```

### (c) Async eventing — producer → outbox → relay → Kafka → consumer

*No dual-write: the event is staged in `event_outbox` in the business txn, then drained at-least-once by the in-process relay.*

```mermaid
flowchart TB
  producer["Producer pod<br/>(any API service)"]
  pg[("event_outbox<br/>in PostgreSQL")]
  rly["initOutboxRelay()<br/>in-process in every producer pod<br/>poll → publish → mark"]
  kafka{{"Kafka<br/>domain-event topics + .dlq"}}

  subgraph consumers["Worker pods — one group per service"]
    expw[expense-worker]
    wfw["workflow-worker<br/>(rules + connector-sync)"]
    notifw[notification-worker]
  end

  ext[("ERP connectors<br/>LedgerOne / Finovo / AcctBridge")]

  producer -. "stage event (same txn)" .-> pg
  rly -->|"SELECT pending FOR UPDATE SKIP LOCKED"| pg
  rly =="publish (at-least-once)"==> kafka
  kafka -->|"consume (group per service)"| expw & wfw & notifw
  wfw -->|"pushTransaction (idempotent)"| ext
```

> Note: `expense` also pushes to ERP **synchronously** on approval (in addition to the
> connector-sync worker path), so the ERP seam is reachable from both the sync and async sides.

### (d) Casbin policy-reload bus — PAP write fans out via Redis pub/sub

*A PAP write in user-management projects into the policy table, then PUBLISHes a reload every pod SUBSCRIBEs to.*

```mermaid
flowchart TB
  um["user-management<br/>(PAP)"]
  pg[("policy table<br/>in PostgreSQL")]
  redis[("Redis<br/>policy-reload pub/sub")]
  pods["all API pods<br/>(rebuild enforcer<br/>from policy table)"]

  um <-->|"Casbin enforcer build-once"| pg
  um =="PAP write → PUBLISH reload"==> redis
  redis -->|"SUBSCRIBE policy-reload"| pods
  pods -.->|"reload from store (fail-closed)"| pg
```

### (e) PROCESS_TYPE pod roles — per-service images, three runtime roles

*Each service image can run as an `api`, `worker`, or one-shot `migration` pod, selected by env vars.*

```mermaid
flowchart TB
  img["Per-service image<br/>SERVICE_NAME + PROCESS_TYPE"]
  api["api pod<br/>HTTP listener<br/>+ in-process outbox relay"]
  worker["worker pod<br/>Kafka consumers<br/>no HTTP"]
  mig["migration pod<br/>one-shot: migrate<br/>+ migrate-seeders, then exit"]

  img -->|"PROCESS_TYPE=api"| api
  img -->|"PROCESS_TYPE=worker"| worker
  img -->|"PROCESS_TYPE=migration"| mig
```

**The invariants these diagrams encode:**

- **North-south is HTTP, always through the gateway.** The gateway mints `X-Correlation-Id` at the
  edge, validates context headers, and reverse-proxies the first path segment to the owning service —
  but it does **not** authorize. Every service re-runs `authenticate` + `authorize` (defense in
  depth; boot fails if any non-public route lacks a guard).
- **East-west is asynchronous via Kafka domain events**, never synchronous RPC for domain workflows.
- **No dual-write:** a domain event is staged into `event_outbox` *inside the same transaction* as
  the business write, then drained at-least-once by the in-process relay (`FOR UPDATE SKIP LOCKED`).
- **Tenant isolation is in the database.** Every access goes through `withTenantTransaction`, which
  sets `app.current_tenant` transaction-locally so the RESTRICTIVE/FORCE RLS policy is in force; the
  runtime DB role is `NOBYPASSRLS`.
- **Per-service images, many roles.** `PROCESS_TYPE` (`api` / `worker` / `migration`) + `SERVICE_NAME`
  select the role at runtime; the outbox relay runs in-process inside producer pods (no separate
  relay pod). APIs and workers are separate containers and scale independently.

---

## How to read this — the chapter index

Read the five chapters in order for the full picture, or jump to the one you need.

| # | Chapter | One-line summary |
|---|---|---|
| **01** | [System Overview](./architecture/01-system-overview.md) | The whole picture: the 8 services + cli, the Postgres/Redis/Kafka infra, the per-service image + `PROCESS_TYPE` model, inter-service topology, and request-context propagation end-to-end. |
| **02** | [Rules & Workflow](./architecture/02-rules-and-workflow.md) | The `workflow` service as a rules-as-data engine: the four rules tables, how a rule is authored and executed, the AND/OR step semantics, the six built-in actions, and the end-to-end auto-approval flow. |
| **03** | [Approvals & Expense](./architecture/03-approvals-and-expense.md) | The shared `@aegis/approvals` multi-level engine (policies, resolver, sequential/parallel quorum, the vote ledger) and the expense lifecycle that consumes it — plus how invoice & payroll reuse it (incl. payroll maker-checker SoD). |
| **04** | [Services](./architecture/04-services.md) | Each business service (user-management, payroll, invoice, reporting, notification) and the cross-cutting libs (connectors, audit, activity) — purpose, key tables, endpoints, and signature flows. |
| **05** | [Data Model](./architecture/05-data-model.md) | The single Postgres schema: the RLS policy pattern + its exceptions, column conventions, append-only/optimistic-lock tables, every domain's ER diagram, the outbox/casbin specifics, and enum-backed CHECKs. |

---

## Quick reference: a request's lifecycle

What happens on a single authenticated write (e.g. `POST /expense/reports`). Full detail in
[chapter 01 §4–5](./architecture/01-system-overview.md).

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant GW as gateway
  participant SVC as service (api pod)
  participant PEP as PEP (authn/authz)
  participant CAS as Casbin enforcer
  participant PG as PostgreSQL (RLS)
  participant OBX as event_outbox

  C->>GW: POST /<svc>/... (Bearer JWT, X-Tenant-Id)
  Note over GW: contextMiddleware mints X-Correlation-Id,<br/>validates headers, opens AsyncLocalStorage scope
  GW->>SVC: forward + X-Tenant-Id, X-Correlation-Id, X-Caller=gateway, Bearer
  Note over SVC: re-opens ALS scope from headers (no mint → fail-closed)
  SVC->>PEP: authenticate() → verify JWT, assert claim tenant == X-Tenant-Id
  SVC->>PEP: authorize('expense.submit', ...)
  PEP->>CAS: enforce(role|userId, tenantId, permission)
  CAS-->>PEP: allow / deny (fail-closed → 403)
  SVC->>PG: withTenantTransaction → SET LOCAL app.current_tenant
  SVC->>PG: business write (RLS WITH CHECK)
  SVC->>OBX: stageOutboxEvent(...) — SAME txn
  PG-->>SVC: COMMIT (write + event atomic)
  SVC-->>GW: 201
  GW-->>C: 201 (echoes X-Correlation-Id)
```

1. **Edge** — gateway mints the correlation id (the only place that mints), validates headers, opens
   the `RequestContext` (AsyncLocalStorage) scope, and proxies to the owning service.
2. **Re-validate** — the downstream service re-opens its own scope from the propagated headers;
   internal services never mint, so a hop missing a correlation id fails closed.
3. **Authn + Authz** — the PEP verifies the JWT, asserts the token tenant matches `X-Tenant-Id`,
   enriches the context with `userId`/`roles`, then Casbin enforces the permission (fail-closed).
4. **Tenant transaction** — `withTenantTransaction` issues `SET LOCAL app.current_tenant`, so RLS is
   in force for every statement.
5. **Atomic write + event** — the business row and its domain event (`event_outbox`) commit in one
   transaction. No dual-write window.

---

## Quick reference: an event's journey (outbox → relay → Kafka → consumer)

How a staged event reaches the rest of the system. Full detail in
[chapter 01 §4](./architecture/01-system-overview.md) and the outbox diagram in
[chapter 05 §3.10](./architecture/05-data-model.md).

```mermaid
flowchart LR
  subgraph tx["Producer txn (app.current_tenant set)"]
    W["Domain write"] --> O["INSERT event_outbox<br/>status=pending<br/>envelope: tenantId + correlationId"]
  end
  tx -->|"COMMIT (atomic)"| DB[(event_outbox)]
  RLY["in-process relay<br/>SET LOCAL app.outbox_relay='on'"] -->|"poll pending<br/>FOR UPDATE SKIP LOCKED"| DB
  RLY ==>|"bus.publish (key = tenantId)"| K{{"Kafka topic"}}
  RLY -->|"mark published<br/>(only after publish resolves)"| DB
  K -->|"consume (group per service)"| CON["consumer (worker pod)"]
  CON -->|"RequestContext.run rebuilt<br/>from envelope"| CTX["same tenant + correlationId<br/>as producer"]
  CON -->|"retry w/ backoff → &lt;topic&gt;.dlq"| DLQ[(dead-letter)]
```

1. **Stage** — the producer writes the event into `event_outbox` in the *same* transaction as the
   business write (`stageOutboxEvent`), so it commits or rolls back atomically.
2. **Relay** — the in-process relay (`initOutboxRelay()`, every producer pod) sets
   `app.outbox_relay='on'` so one poll can drain every tenant's backlog past RLS, selects pending rows
   with `FOR UPDATE SKIP LOCKED` (safe to run many relays), publishes, and marks the row `published`
   **only after** the publish resolves — **at-least-once**.
3. **Transport** — Kafka partitions by `tenantId` so a tenant's events keep ordering. (With
   `KAFKA_BROKERS` unset in single-process dev, an in-process bus is the drop-in transport.)
4. **Consume** — the consumer (worker pod, one group per service) rebuilds the `RequestContext` from
   the envelope, so it runs under the *same* tenant + correlation id the producer was authorized
   under. Handlers are idempotent (envelope `id`); bounded retries dead-letter to `<topic>.dlq` before
   the offset advances.

---

## Where to go next

| You want… | Go to |
|---|---|
| To run, test, and continue the platform with zero prior context | [`HANDOFF.md`](../HANDOFF.md) — the onboarding doc; **`SPEC.md` is the single source of truth** when docs disagree |
| An interactive, clickable map of every end-to-end flow | [`docs/flows.html`](./flows.html) — the Flow Coverage Dashboard |
| The HTTP API contract (every endpoint, schema, guard) | [`docs/api/`](./api/) — `openapi.yaml` + the rendered `index.html` |
| The original deep-dive set (access-control model, s2s, ops, compliance) | [`docs/README.md`](./README.md) and `docs/01-…` through `docs/10-…` |
| Deployment topology & the pod matrix | [`docs/deployment-topology.md`](./deployment-topology.md) and [chapter 01 §3](./architecture/01-system-overview.md) |
