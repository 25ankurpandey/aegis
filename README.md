# Aegis

**Aegis is an enterprise access-control platform for a multi-tenant, microservices SaaS** — a fleet of business services (expense, payroll, reporting, invoice, workflow, notification, user-management) behind a single gateway, all sharing one access-control core, with tenant isolation enforced in the database itself.

It is built to be assessed: every cross-cutting concern an enterprise reviewer cares about — tenant isolation, fine-grained authorization, eventing, approvals, auditability — has a real implementation and a doc that explains it.

## Highlights

- **Database-enforced multi-tenancy** — shared-DB pooled model with a mandatory `tenant_id` and PostgreSQL Row-Level Security (`FORCE` + `RESTRICTIVE`). The app runs as a non-owner role without `BYPASSRLS`; every transaction sets `SET LOCAL app.current_tenant`, so cross-tenant reads are impossible even with a bug in app code.
- **RBAC + ABAC + row-level scope** — a Casbin-backed policy engine over a dotted `domain.action` permission vocabulary, with attribute conditions and row-level scoping. Clean PDP / PEP / PAP / PIP split and a decision cache.
- **Event-driven backbone** — Kafka eventing with the **transactional outbox** pattern (events written in the same DB transaction as the state change, relayed by an in-process outbox relay) and a **dead-letter queue** for poison messages. Workflow and notification run as dedicated Kafka workers.
- **Multi-level approval engine** — a reusable approvals library driving expense and invoice routing: policy-defined approval chains and maker-checker / segregation of duties.
- **Org modeling** — tenants, users, memberships, dynamic roles, org hierarchy, **teams**, **labels/tags**, and invites — the user-management service is the system of record and Policy Administration Point.
- **Tamper-evident audit** — a hash-chained, append-only activity feed plus per-domain audit tables, with field-level encryption for the highest-sensitivity PII (payroll).
- **Service-to-service security** — propagated request context (`X-Tenant-Id`, `X-Correlation-Id`, `X-Source-Service`), a signed internal JWT gated by `X-Internal-Origin`, fail-closed header validation, and RFC 8693 token exchange.
- **Pluggable ERP connectors** — `@aegis/connectors` adapter/registry framework with mock connectors, so ERP push is provable without calling a real ERP.

Built on an **Nx monorepo** (TypeScript) with Express, InversifyJS DI, Sequelize, Casbin, KafkaJS, and Redis.

## Quick start

Prerequisite: **Docker Desktop** (Engine + Compose v2) running. That is the only external dependency — Postgres, Redis, Kafka, all 9 services, and the 2 Kafka workers come up as one stack.

```bash
npm ci                 # install workspace dependencies
bash scripts/setup.sh  # build per-service images + bring the whole stack up (idempotent)
```

`scripts/setup.sh` is the one-command path for a brand-new machine: it preflights Docker, builds one image per deployable service from the monorepo (`aegis/gateway:local`, `aegis/expense:local`, and so on), brings up Postgres (+RLS app role), Redis, Kafka, the gateway and seven services plus the two Kafka workers, runs migrations and seeders, then polls `/health` on every service until ready. Re-running it is safe.

This is a **microservices deployment**, not a monolith: the Nx repo is shared for atomic library changes, but each API service and each worker runs in its own container and can be scaled independently. The workflow and notification workers reuse their service images with `PROCESS_TYPE=worker`; the CLI image runs migrations as a one-shot task.

When it finishes, the gateway is at **http://localhost:4000** and a demo tenant is seeded and ready to log in (`admin@demo-org.test` / `demo-admin-pw`, `x-tenant-id: 00000000-0000-4000-8000-000000000001`). A second tenant exists to demonstrate cross-tenant RLS isolation.

### Testing

```bash
npx jest               # run the unit / integration test suites
```

For **live end-to-end** testing against the running stack, follow the [Testing Guide](docs/testing/TESTING_GUIDE.md) — it walks you through curl recipes ([CURL_EXAMPLES.md](docs/testing/CURL_EXAMPLES.md)), the Postman collection ([Aegis.postman_collection.json](docs/postman/Aegis.postman_collection.json)), and the deeper [Live E2E Runbook](docs/testing/LIVE_E2E_RUNBOOK.md) (side effects, RLS, the audit hash chain, the DLQ).

## Navigation

| I want to… | Go to |
|---|---|
| **Browse the API** (offline) | [docs/api/index.html](docs/api/index.html) — open in a browser. Source: [docs/api/openapi.yaml](docs/api/openapi.yaml) |
| **Browse the API** (live, interactive) | <http://localhost:4000/api-docs> — interactive Swagger served by the gateway (available after `scripts/setup.sh`) |
| **Understand the architecture** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| **Read a single service's design** | [docs/services/](docs/services/) — one doc per service |
| **Find any doc** | [docs/README.md](docs/README.md) — the full documentation index |
| **Test the platform** | [docs/testing/TESTING_GUIDE.md](docs/testing/TESTING_GUIDE.md) |
| **See the deployment topology** | [docs/deployment-topology.md](docs/deployment-topology.md) |
| **Read the spec** (source of truth) | [SPEC.md](SPEC.md) |
| **Onboard / hand off** | [HANDOFF.md](HANDOFF.md) |
| **See the build plan** | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |
| **Run the stack** | [scripts/setup.sh](scripts/setup.sh) |

### Per-service docs

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
