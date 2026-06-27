# Aegis

**Enterprise access control for a multi-tenant, microservices SaaS platform.**

Aegis is a working reference platform for getting access control *right* across many services and many
tenants at once: centralized authorization (Casbin RBAC-with-domains + ABAC), **database-enforced**
tenant isolation (PostgreSQL Row-Level Security), signed service-to-service tokens, runtime
role/permission management with no redeploy, a multi-level approval engine, Kafka eventing with a
transactional outbox, and tamper-evident hash-chained auditing — built to scale to thousands of
tenants.

> **Why "Aegis"?** In Greek mythology the *aegis* is the shield of Zeus and Athena. That's what this
> platform is: the protective access-control layer every service operates under.

---

## This is a platform, not a monolith

Aegis is **not** a monolith. It is a **gateway + 8 services** plus shared libraries, developed
together in a single **Nx monorepo** for atomic cross-cutting changes, but **deployed and scaled
separately**. Every service is its own stateless Node process with its own routes, models, and
migration — they talk over HTTP (through the gateway and signed s2s calls) and a Kafka **event bus**,
never by reaching into each other's code.

**One image, many roles.** The whole monorepo builds into a single Docker image; the runtime role is
selected by env (`scripts/start.sh`):

| `PROCESS_TYPE` | Role |
|---|---|
| `api` | Run the HTTP service named by `SERVICE_NAME` (the default). |
| `worker` | Run that service's Kafka consumer (workflow + notification swap in the consumer on boot). |
| `migration` | Run Umzug migrations + seeders, then exit. |
| `relay` | Drain the transactional outbox to the bus at-least-once (`OutboxRelay`). |

This guarantees every service, worker, migration runner, and relay are the exact same byte-identical
build.

### Request path

```
client → gateway (validate context, mint X-Correlation-Id, route, timeout)
       → service: contextMiddleware (strict, fail-closed header validation)
       → authenticate (verify JWT, set principal)
       → authorize(permission) — Casbin enforce(role, tenant, permission), fail-closed
       → handler → tenant-scoped DB query (Row-Level Security) → audit + outbox events
```

Architecture deep-dive: [`docs/01-architecture.md`](docs/01-architecture.md) · interactive
walkthrough: [`docs/interactive/index.html`](docs/interactive/index.html).

---

## Enterprise capabilities (each one integrated, and where it lives)

| Capability | One line | Where |
|---|---|---|
| **Multi-tenant RLS** | `FORCE ROW LEVEL SECURITY` + `RESTRICTIVE` policy keyed on `app.current_tenant`; app runs as a non-owner without `BYPASSRLS`, so a buggy query cannot cross tenants. | `libs/db/src/rls.ts` |
| **Casbin RBAC + domains** | `model.conf` = `sub, dom, act` with **`dom` = tenantId** (real tenant scoping, not the `'*'` hack); `authorize()` calls `enforce(role, tenant, permission)`. | `libs/access-control/src/enforcer.ts`, `pep.ts` |
| **Runtime policy reload** | Policy changes (new role/permission) take effect live via a Casbin watcher — no redeploy, no migration. | `libs/access-control/src/watcher.ts`, `policy-loader.ts` |
| **ABAC amount-caps** | Declarative conditions (approver may approve up to $X, owner-only, status gates) evaluated by the PDP after RBAC passes. | `libs/access-control/src/condition-evaluator.ts`, `pdp.ts` |
| **Feature flags + tenant config** | Per-tenant `tenant_config` / `tenant_features`, read through a cached flag helper; gate any feature by flag. | `libs/service-core/src/config/feature-flags.ts`, `cache/flag-cache.ts` |
| **Kafka eventing** | `kafkajs` producer + back-pressure consumer + `CommitManager` (at-least-once). | `libs/events/src/kafka-bus.ts` |
| **Producer on every pod** | Every API pod boots a producer so any write-path can emit without a side hop. | `libs/events/src/init-bus.ts` |
| **Transactional outbox + relay** | Events staged inside the business tx (no dual-write gap); a separate relay drains them with `FOR UPDATE SKIP LOCKED`. | `libs/events/src/outbox.ts`, `init-relay.ts` |
| **DLQ** | Retry-then-dead-letter on both transports (`topic.dlq` on Kafka); never silently swallowed. | `libs/events/src/kafka-bus.ts`, `bus.ts` |
| **Multi-level approval engine** | Policies → manager-hierarchy(level) → approver-groups(user/role/team) → thresholds; next-approver resolver + progress log; parallel/sequential. | `libs/approvals/src/` (`resolver.ts`, `approval.service.ts`) |
| **Segregation of duties** | Maker-checker: the pay-run approver must differ from the input editor, double-guarded. | `apps/payroll/` + `libs/approvals/` |
| **Hash-chained audit** | Append-only `audit_log` with a sha256 prev-hash chain + `verifyChain`; captures actor/tenant/decision/permissions-at-time. | `libs/audit/src/audit-logger.ts`, `hash.ts` |
| **PII-read audit** | Every sensitive-field read (AES-256-GCM salary/bank/national-id) is audited, not just writes. | `apps/payroll/` + `libs/audit/` |
| **Shared activity timeline** | Generic append-only activity feed any service writes to for a unified per-entity history. | `libs/activity/src/activity-logger.ts` |
| **Notifications** | Recipient resolver, per-user preferences, template engine, SMS + email, suppression list, sender identity. Dev email = **nodemailer** (no SES). | `apps/notification/src/services/` |
| **Connector ERP sync** | Pluggable connector framework (interface + registry + per-kind transformer) with mock ERPs; durable sync-state + reconciliation. | `libs/connectors/src/` (`registry.ts`, `sync-state.ts`, `transformer.ts`) |
| **Optimistic locking** | Version-column concurrency control on mutable aggregates. | `libs/db/src/base-model.ts` |
| **Idempotency replay** | `Idempotency-Key` middleware replays the stored response instead of re-executing. | `libs/service-core/src/middleware/idempotency.middleware.ts` |
| **Graceful shutdown** | SIGTERM drains in-flight work, closes DB/cache/bus, then exits. | `libs/service-core/src/bootstrap/shutdown.ts` |
| **Gateway timeouts** | Edge proxy bounds every downstream call. | `apps/gateway/src/proxy.ts` |

---

## Services (`apps/`)

| Service | What it does |
|---|---|
| `gateway` | Single entry point. Validates context, **mints `X-Correlation-Id`**, routes/proxies, bounds timeouts. Each service still enforces its own auth (defense in depth). |
| `user-management` | Identity + access **system of record**: reference IdP (login → permission-bearing JWT), the **PAP** (create roles/permissions + assign roles **at runtime**), tenants, memberships, tenant config + feature flags. |
| `expense` | Expense reports + line expenses, multi-status approval state machine, ERP push of approved reports. |
| `payroll` | Employees (AES-256-GCM field encryption), pay-run lifecycle Draft→Calculated→Approved→Paid with **maker-checker**, append-only disbursement ledger, GL push. |
| `reporting` | Declarative report definitions + async runs (`202` + `runId`), RLS read models, column-masking. |
| `workflow` | Rules-as-data engine (conditions + actions), event-triggered, with a per-run audit log. |
| `notification` | Event-driven in-app + email + SMS, idempotent send; never re-derives authority. |
| `invoice` | Header-level invoice lifecycle (receive → review → approve) + duplicate-entry guard + ERP push. |
| `cli` | Migrations + seeders (`PROCESS_TYPE=migration`). |

## Shared libraries (`libs/`)

| Library | Responsibility |
|---|---|
| `@aegis/service-core` | Request context (AsyncLocalStorage), structured logging, typed errors + one envelope, context-propagating HTTP client + signed internal s2s tokens, config/secrets, Redis cache + flag cache, the middleware band (context/auth/idempotency/audit/error/cors/validation) + bootstrap + graceful shutdown. |
| `@aegis/access-control` | Casbin enforcer (RBAC-with-domains), policy loader + watcher (runtime reload), ABAC condition evaluator, row-level scope, and the `authenticate`/`authorize` PEP guards. |
| `@aegis/db` | Non-owner Sequelize connection (so RLS is enforced), RLS helpers (`SET LOCAL` tenant context, FORCE/RESTRICTIVE SQL), tenant-scoped transactions, optimistic-lock base model, Umzug runner. |
| `@aegis/events` | Kafka bus (producer + back-pressure consumer + CommitManager), transactional outbox + relay, topic/payload catalog, DLQ. |
| `@aegis/approvals` | Multi-level approval engine: policies, manager hierarchy, approver groups, thresholds, next-approver resolver, progress log. |
| `@aegis/connectors` | Pluggable ERP framework (connector interface + registry + per-kind transformer) with mock connectors, durable sync-state + reconciliation. |
| `@aegis/audit` | Append-only, **hash-chained** tamper-evident audit log + `verifyChain`. |
| `@aegis/activity` | Generic append-only activity timeline any service can write to. |
| `@aegis/shared-enums` / `-types` / `-constants` | Domain enums (incl. `HttpHeaderKey`, `TableName`, the dotted `Permission` catalog), DTO/shape namespaces, per-area constants. |
| `@aegis/testing` | Test fixtures (context stubs, principal/resource builders). |

---

## Quick start (one command)

```bash
npm ci
bash scripts/dev-up.sh          # or VS Code: Cmd+Shift+B  ("Aegis: Up")
```

`scripts/dev-up.sh` builds every service image and brings up dockerized **Postgres** (pre-seeded with
the non-owner RLS app role via `scripts/db-init/`), **Redis**, and **Kafka**, applies migrations +
seeders, and runs every service + worker + the outbox relay wired on one Docker network. Per-service
`.env` files ship with consistent dummy values, so a fresh checkout works with **zero manual setup**.
Gateway: `http://localhost:4000`. A demo tenant + admin (`admin@demo-org.test`) is seeded.

> Docker is not required to build or unit-test — only to run the live stack.

> **Running the stack without Docker (optional, dev only).** If you want all ten Node roles in one
> terminal without Docker, point them at a local Postgres/Redis/Kafka and use the dev-only PM2
> launcher: `npm run build && npm run migrate && npm run migrate:seed`, then `npm run dev:pm2`
> (`npm run dev:pm2:stop` to stop). See [`ecosystem.config.js`](ecosystem.config.js) and
> [`docs/architecture/process-management.md`](docs/architecture/process-management.md). PM2 is a
> dev convenience only — **production uses the container + `PROCESS_TYPE` model**, never PM2.

## How to test

```bash
npx jest                        # ~580 unit tests across 96 suites
npx nx run-many -t build --all  # every app builds & bundles
npx nx run-many -t lint --all   # 0 errors
```

**Live end-to-end** (cross-tenant RLS isolation, login→JWT→PEP, runtime role granting,
approve→ERP push, notification idempotency, Kafka cross-service flow, audit `verifyChain`) runs
against a dockerized stack — push-button procedure in
[`docs/testing/LIVE_E2E_RUNBOOK.md`](docs/testing/LIVE_E2E_RUNBOOK.md). The gated jest harness lives
in [`apps/e2e-tests/live/`](apps/e2e-tests/live) (SKIPPED unless `E2E_BASE_URL` is set).

---

## Repo map

```
aegis/
├── apps/
│   ├── gateway/          # edge: context validation, correlation-id, routing, timeouts
│   ├── user-management/  # identity + IdP + PAP + tenant config / feature flags
│   ├── expense/  invoice/  payroll/  reporting/  workflow/  notification/
│   ├── cli/              # migrations + seeders (PROCESS_TYPE=migration)
│   └── e2e-tests/        # gated live E2E harness
├── libs/
│   ├── service-core/  access-control/  db/  events/  approvals/
│   ├── connectors/  audit/  activity/  testing/
│   └── shared/{enums,types,constants}/
├── docs/                 # architecture, access-control model, multi-tenancy, s2s, data
│   │                     #   models, ops, audit + per-service docs + interactive HTML
│   └── testing/          # flow catalogue, FLOWS_v2, LIVE_E2E_RUNBOOK
├── infra/terraform/      # one `terraform apply` cloud stand-up (env/{dev} + modules/)
├── scripts/              # dev-up.sh, start.sh (PROCESS_TYPE switch), db-init/
├── Dockerfile            # single multi-purpose image
└── SPEC.md  DESIGN.md  IMPLEMENTATION_PLAN.md  AGENTS.md
```

---

## Documentation

- **Source of truth** → [`SPEC.md`](SPEC.md) · **design doc** → [`DESIGN.md`](DESIGN.md) ·
  **build status** → [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)
- **Explainers** → [`docs/`](docs/) (architecture, patterns, access-control model, multi-tenancy,
  authn/authz flow, service-to-service, data models, API conventions, deployment, audit) + per-service
  docs in [`docs/services/`](docs/services/)
- **Interactive flow walkthrough** → [`docs/interactive/index.html`](docs/interactive/index.html)
- **Testing** → [`TESTING_PLAN.md`](TESTING_PLAN.md), [`docs/testing/flow-catalogue.md`](docs/testing/flow-catalogue.md),
  [`docs/testing/LIVE_E2E_RUNBOOK.md`](docs/testing/LIVE_E2E_RUNBOOK.md)
- **For AI agents** → [`AGENTS.md`](AGENTS.md)
