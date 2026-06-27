# Aegis

**Aegis is an enterprise access-control platform for a multi-tenant, microservices SaaS** — a fleet of business services (expense, payroll, reporting, invoice, workflow, notification, user-management) behind a single gateway, all sharing one access-control core, with tenant isolation enforced in the database itself.

It is built to be assessed: every cross-cutting concern an enterprise reviewer cares about — tenant isolation, fine-grained authorization, eventing, approvals, auditability — has a real implementation and a doc that explains it.

## Capabilities

What you can actually do with Aegis, grouped by area. The access-control and security capabilities are
shared by every business service; the business services are the user-facing workflows on top.

### Access control & security (the platform core)

- **Database-enforced multi-tenancy** — shared-DB pooled model with a mandatory `tenant_id` and
  PostgreSQL Row-Level Security (`FORCE` + `RESTRICTIVE`). The app runs as a non-owner role without
  `BYPASSRLS`; every transaction sets `SET LOCAL app.current_tenant`, so cross-tenant reads are
  impossible even with a bug in app code. A second seeded tenant lets you prove the isolation live.
- **RBAC + ABAC + row-level scope** — a Casbin-backed policy engine over a dotted `domain.action`
  vocabulary (**11 system roles × 57 permissions**, see the
  [access-control matrix](docs/access-control-matrix.md)), plus attribute conditions (e.g. approval
  amount caps) and row-level scoping. Clean PDP / PEP / PAP / PIP split with a decision cache.
- **Identity & org modeling** — tenants, users, memberships, **dynamic/custom roles**, org hierarchy,
  **teams**, **labels/tags**, **invites**, **sessions** (list/revoke), workspace switching, and
  policy administration. user-management is the system of record and Policy Administration Point.
- **Tamper-evident audit** — a hash-chained, append-only activity feed plus per-domain audit tables,
  with **field-level encryption** for the highest-sensitivity PII (payroll).
- **Service-to-service security** — propagated request context (`X-Tenant-Id`, `X-Correlation-Id`,
  `X-Source-Service`), a signed internal JWT gated by `X-Internal-Origin`, fail-closed header
  validation, defense-in-depth per-service PEP re-validation, and RFC 8693 token exchange.

### Business services (the workflows)

- **Expense management** — expense reports with line items, **multi-level approval** routing,
  rejection/recall, reimbursement, and ERP push on approval.
- **Invoice management** — full invoice lifecycle with **currency-aware duplicate detection**,
  matching, and approval.
- **Payroll** — employees, **pay-runs** (create → calculate → approve → disburse) with
  **maker-checker / segregation of duties**, payslips (own vs all), idempotent disbursement, and
  field-encrypted sensitive PII (the `payroll.sensitive.read` obligation gates exposure).
- **Reporting** — report definitions, on-demand **report runs**, async **export**, and schedules over
  CQRS-lite read models.

### Cross-cutting workflow & integration

- **Multi-level approval engine** — a reusable library driving expense/invoice/payroll routing:
  sequential / parallel / quorum chains, amount thresholds (bigint-safe), manager-chain resolution,
  approver groups, SoD (`excludeRequester`), and reassign / supersede.
- **Rules-as-data workflow engine** — tenant-defined rules triggered by domain events, with conditions
  and actions: **auto-approve, assign approval policy, assign team, add tag, notify, push to ERP
  connector** — all audited per run.
- **Notifications & email** — in-app + email notifications with **text + HTML templates**, a recipient
  directory, per-user preferences, and an idempotent, event-only write path.
- **Event-driven backbone** — Kafka eventing with the **transactional outbox** pattern (events written
  in the same DB transaction as the state change, relayed in-process) and a **dead-letter queue** for
  poison messages. Workflow and notification run as dedicated Kafka workers.
- **Pluggable ERP connectors** — `@aegis/connectors` adapter/registry framework with mock connectors
  and per-tenant connector config, so ERP push is provable without calling a real ERP.
- **API surface** — single gateway edge (routing, correlation IDs, idempotency, standard error
  envelope, pagination) with a **live interactive Swagger UI** at `/api-docs` and an offline viewer.

Built on an **Nx monorepo** (TypeScript) with Express, InversifyJS DI, Sequelize, Casbin, KafkaJS, and
Redis. Deployed as **one container image per service** (role chosen by `PROCESS_TYPE`).

## Requirements

Running the full stack needs **only Docker** — nothing else is installed on your host.

- **Docker Desktop or Docker Engine + Compose v2** — *required*. Postgres, Redis, Kafka, the gateway,
  all seven business services, the two Kafka workers, and the migration job are all built and run as
  containers. Verify with `docker --version` and `docker compose version`.
- **Resources** — the first run builds eight service images, so give Docker headroom: **≥ 4 CPUs,
  ≥ 8 GB RAM**, and **~6 GB free disk** for images + build cache. More CPU = faster build.
- **Host ports** (overridable) — `4000`–`4007` (gateway + services), `4010` (log dashboard), and
  `5432` / `6379` / `9092` (Postgres / Redis / Kafka). If one is busy, override via
  `AEGIS_POSTGRES_PORT` / `AEGIS_REDIS_PORT` / `AEGIS_KAFKA_PORT`.

**Optional — only for host-side development** (not needed to run the Dockerized stack): **Node 22 +
npm**, which enables `npm ci` → `npx jest` (unit/integration tests), the browser log dashboard, and
`npx nx serve <service>` for hot-reload local development.

## Quick Start

The one-command path for a brand-new machine — Docker is the only prerequisite:

```bash
npm ci                 # recommended: enables local tests and the browser log dashboard
bash scripts/setup.sh  # builds images, starts infra/services/workers, runs migrations+seeders
```

`scripts/setup.sh` is the one-command path for a brand-new machine. It preflights Docker, builds one
image per deployable service from the monorepo (`aegis/gateway:local`, `aegis/expense:local`, and so
on), starts the stack, runs migrations and seeders through the one-shot CLI container, and polls every
`/health` endpoint until the platform is ready. Re-running it is safe and idempotent.

This is a **microservices deployment**, not a monolith. The Nx repo is shared for atomic library
changes, but each API service has its own image and container so it can be deployed and scaled
independently. The workflow and notification workers reuse their owning service images with
`PROCESS_TYPE=worker`; the CLI image runs migrations with `PROCESS_TYPE=migration`.

### How long does setup take?

`scripts/setup.sh` runs in sequence; the **first** run is dominated by building the eight service
images, after which the image layers are cached and re-runs are fast.

| Phase | First run (cold) | Re-run (images cached) |
|---|---|---|
| Build 8 service images | ~5–10 min | skipped (layer-cached) |
| Start infra + services | ~30–60 s | ~30–60 s |
| Migrations + seeders | ~15–30 s | ~15–30 s (idempotent) |
| Health-ready (all `/health` green) | ~30–60 s | ~30–60 s |
| **Total before you can test** | **~7–12 min** | **~1.5–2.5 min** |

Times scale with the CPU/RAM you give Docker — the image build parallelizes across cores, so a
multi-core machine with Docker allocated ample resources lands at the low end. After the first build,
`docker compose -f docker-compose.all.yml down` then `bash scripts/setup.sh` again is a ~2-minute warm
start. The script polls `/health` and only prints "✅ Aegis is up" once every service answers, so you
never have to guess — when it returns, the stack is ready to test.

### After Setup

| Surface | URL / command |
|---|---|
| Gateway | <http://localhost:4000> |
| Live API docs | <http://localhost:4000/api-docs> |
| Raw OpenAPI spec | <http://localhost:4000/api-docs.json> |
| Browser logs + analytics | <http://127.0.0.1:4010> |
| Offline API docs | [docs/api/index.html](docs/api/index.html) |
| Stack status | `docker compose -f docker-compose.all.yml ps` |
| Stack logs fallback | `docker compose -f docker-compose.all.yml logs -f --tail=100` |
| Stop stack, keep data | `docker compose -f docker-compose.all.yml down` |
| Reset all Docker data | `docker compose -f docker-compose.all.yml down -v` |

#### Live monitoring dashboard (`http://127.0.0.1:4010`)

Once the stack is up, open <http://127.0.0.1:4010> for a real-time, browser-based operations view of
the whole platform — no extra tooling. It streams over Server-Sent Events (live, no refresh) and shows:

- **Live log tail for every service** — gateway + all seven business services + the two Kafka workers,
  interleaved or filtered per service, colour-coded by level (info / warn / error).
- **Per-service analytics** — request count with a **2xx / 4xx / 5xx** breakdown, running **error and
  warning** counts, request **latency** (from the structured request logs), and each service's last-seen
  time and health.

Use it to **watch a flow execute end-to-end across services** as you fire curls or run the Postman
collection, to spot a `5xx`/error the moment it happens, and to see which hop is slow — all in one place
instead of tailing `docker compose logs`. It is started automatically by `scripts/setup.sh` when Node.js
is present; if Node is not installed the Dockerized stack still runs normally — use Compose logs directly.

### Seeded Demo Users

| Tenant | Header | Login |
|---|---|---|
| Demo Org | `x-tenant-id: 00000000-0000-4000-8000-000000000001` | `admin@demo-org.test` / `demo-admin-pw` |
| Demo Org B | `x-tenant-id: 00000000-0000-4000-8000-000000000002` | `admin@demo-org-b.test` / `demo-admin-pw-b` |

The seeded admins hold the full permission catalog. Tenant B exists so testers can verify
cross-tenant RLS isolation with real API calls.

### Local Infra Credentials

These are intentionally local/demo credentials so reviewers can connect with TablePlus, DBeaver,
`psql`, RedisInsight, Kafka tools, or their own scripts after `scripts/setup.sh` finishes.

| System | Host config from your machine | Credentials / URL |
|---|---|---|
| Postgres owner role | `127.0.0.1:5432`, database `aegis` | `aegis_owner` / `aegis_local`, `postgres://aegis_owner:aegis_local@127.0.0.1:5432/aegis` |
| Postgres app/RLS role | `127.0.0.1:5432`, database `aegis` | `aegis_app` / `aegis_app_pw`, `postgres://aegis_app:aegis_app_pw@127.0.0.1:5432/aegis` |
| Redis | `127.0.0.1:6379` | no password, `redis://127.0.0.1:6379` |
| Kafka | `127.0.0.1:9092` | PLAINTEXT, no SASL user/password, bootstrap `127.0.0.1:9092` |

Inside Docker Compose, services use Docker DNS names instead: `postgres:5432`, `redis:6379`, and
`kafka:9092`. From your host terminal, use `127.0.0.1:<port>`. If a host port is busy, override it:

```bash
AEGIS_POSTGRES_PORT=55433 AEGIS_REDIS_PORT=6380 AEGIS_KAFKA_PORT=9092 bash scripts/setup.sh
```

### End-to-End Testing

For a push-button reviewer run that starts the full Dockerized stack, starts the browser dashboard,
and executes scripted real HTTP API calls through the gateway:

```bash
bash scripts/test-dockerized.sh
```

The runner prints each flow as it executes: auth fail-closed checks, dynamic PAP role assignment,
expense submission, teams/tags/assignee annotations, invoice duplicate detection, payroll own-payslip
authorization, reporting run/export/schedule, workflow connector/rule checks, notification inbox
reads, and cross-tenant RLS isolation.

For local code iteration without rebuilding images every time, use Docker for infra and run services
from TypeScript:

```bash
bash scripts/dev-local.sh
AEGIS_BASE_URL=http://127.0.0.1:4000 node scripts/e2e/http-flow-tests.js
bash scripts/dev-local-stop.sh
```

For unit/integration checks:

```bash
npx jest
```

The detailed testing plan lives in [docs/testing/TESTING_GUIDE.md](docs/testing/TESTING_GUIDE.md),
with manual curl recipes in [docs/testing/CURL_EXAMPLES.md](docs/testing/CURL_EXAMPLES.md) and deeper
side-effect checks in [docs/testing/LIVE_E2E_RUNBOOK.md](docs/testing/LIVE_E2E_RUNBOOK.md).

### Develop or extend a service

To work on one service with hot-reload while the rest of the platform runs in Docker: bring up just
the infra, apply the schema, then serve the service from TypeScript.

```bash
docker compose -f docker-compose.all.yml up -d postgres redis kafka      # infra only
docker compose -f docker-compose.all.yml run --rm migrate                # schema + seeders
npx nx serve <service>            # user-management | expense | payroll | reporting | workflow | notification | invoice
```

> **Env gotcha:** the committed `apps/<service>/.env` uses Docker DNS names (`postgres:5432`,
> `redis:6379`, `kafka:9092`, and inter-service URLs like `user-management:4001`). When a service runs
> *outside* Docker via `nx serve`, point those at the published host ports instead —
> `127.0.0.1:5432` / `127.0.0.1:6379` / `127.0.0.1:9092` / `127.0.0.1:400x`.

Each service's doc has a **Local Development** section with its exact env overrides, port,
runtime dependencies, and verify/test/build commands:

[user-management](docs/services/user-management.md#local-development) ·
[expense](docs/services/expense.md#local-development) ·
[payroll](docs/services/payroll.md#local-development) ·
[reporting](docs/services/reporting.md#local-development) ·
[workflow](docs/services/workflow.md#local-development) ·
[notification](docs/services/notification.md#local-development) ·
[invoice](docs/services/invoice.md#local-development)

`npx nx test <service>` runs that service's tests; `npx nx build <service>` runs its production
type-check + bundle.

## Navigation

| I want to… | Go to |
|---|---|
| **Browse the API** (offline) | [docs/api/index.html](docs/api/index.html) — open in a browser. Source: [docs/api/openapi.yaml](docs/api/openapi.yaml) |
| **Browse the API** (live, interactive) | <http://localhost:4000/api-docs> — interactive Swagger served by the gateway (available after `scripts/setup.sh`) |
| **Understand the architecture** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| **See who can do what** (roles × permissions) | [docs/access-control-matrix.md](docs/access-control-matrix.md) |
| **Understand one service** (architecture + request-flow flowcharts) | [docs/services/](docs/services/) — one deep-dive per service, each with internal flow/sequence diagrams · see [Per-service docs](#per-service-docs) |
| **Find any doc** | [docs/README.md](docs/README.md) — the full documentation index |
| **Test the platform** | [docs/testing/TESTING_GUIDE.md](docs/testing/TESTING_GUIDE.md) |
| **Develop / extend a service** | the *Local Development* section in each [docs/services/](docs/services/) doc |
| **See the deployment topology** | [docs/deployment-topology.md](docs/deployment-topology.md) |
| **Read the spec** (source of truth) | [SPEC.md](SPEC.md) |
| **Onboard / hand off** | [HANDOFF.md](HANDOFF.md) |
| **See the build plan** | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |
| **Run the stack** | [scripts/setup.sh](scripts/setup.sh) |

### Per-service docs

**Want to understand how one service works internally?** Each doc below is a deep-dive into a single
service — its **internal architecture**, **request-flow and sequence diagrams** (how a request moves
through the service, step by step, in Mermaid flowcharts), its data model and key invariants, and a
**Local Development** section for running and extending it. Click a service to jump in:

[user-management](docs/services/user-management.md) ·
[expense](docs/services/expense.md) ·
[payroll](docs/services/payroll.md) ·
[reporting](docs/services/reporting.md) ·
[workflow](docs/services/workflow.md) ·
[notification](docs/services/notification.md) ·
[invoice](docs/services/invoice.md) ·
[connectors](docs/services/connectors.md)

### Architecture deep-dives

The numbered docs walk from "what and why" to "how it runs":
[access-control model](docs/03-access-control-model.md) ·
[multi-tenancy / RLS](docs/04-multi-tenancy.md) ·
[authn/authz flow](docs/05-authn-authz-flow.md) ·
[service-to-service](docs/06-service-to-service.md) ·
[data models](docs/07-data-models.md) ·
[API conventions](docs/08-api-conventions.md) ·
[deployment & ops](docs/09-deployment-and-ops.md) ·
[auditability & compliance](docs/10-auditability-and-compliance.md) ·
[patterns](docs/02-patterns.md).
There is also a picture-first [interactive walkthrough](docs/interactive/index.html).

## Repo map

```
aegis/
├── apps/                  deployable services (per-service image, role via PROCESS_TYPE)
│   ├── gateway/           edge: JWT validation, routing, rate limiting, correlation IDs
│   ├── user-management/   identity + access system of record (PAP)
│   ├── expense/           expense reports + multi-level approval + ERP push
│   ├── payroll/           highest-sensitivity PII; field encryption + maker-checker
│   ├── reporting/         CQRS-lite read models, report definitions, async export
│   ├── workflow/          rules-as-data engine driven by domain events
│   ├── notification/      in-app + email notifications (idempotent event consumer)
│   ├── invoice/           header-level invoice lifecycle + matching/approval
│   ├── cli/               migrations, seeders, operational commands
│   └── e2e-tests/         end-to-end test harness
│
└── libs/                  shared libraries (@aegis/*)
    ├── access-control/    RBAC + ABAC + row-level scope; PDP/PEP/PAP/PIP (Casbin)
    ├── approvals/         reusable multi-level approval engine
    ├── events/            Kafka eventing, transactional outbox, DLQ
    ├── audit/             hash-chained tamper-evident audit
    ├── activity/          append-only activity feed
    ├── connectors/        pluggable ERP connector framework + mock adapters
    ├── db/                Sequelize models, migrations, RLS plumbing
    ├── service-core/      RequestContext, logger, error envelope, HTTP client, config
    ├── shared/            shared types, enums, constants, utilities
    └── testing/           shared test helpers and fixtures
```

## License

MIT — see [`package.json`](package.json).
