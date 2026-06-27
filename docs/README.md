# Aegis — Documentation Index

**Aegis** is an enterprise access-control platform for a multi-tenant, microservices SaaS:
seven business services (`user-management`, `expense`, `payroll`, `reporting`, `workflow`,
`notification`, `invoice`) plus a `gateway` and a `cli`, sharing a central RBAC + ABAC
access-control library on an Nx monorepo, with tenant isolation enforced in **PostgreSQL via
Row-Level Security**.

This page is the index to every doc. Where any doc disagrees with [`../SPEC.md`](../SPEC.md),
`SPEC.md` wins.

---

## Start here

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the single entry point: whole-system picture in one
  diagram, the `apps/*` vs `libs/*` split, the request lifecycle, and links into every chapter
  below. Read this first.

---

## Architecture chapters ([`architecture/`](architecture/))

The system broken into focused deep-dives, each traced to real code.

- [`architecture/01-system-overview.md`](architecture/01-system-overview.md) — Nx monorepo
  topology, the nine deployables + ten shared libs, and the `@aegis/service-core` /
  `@aegis/access-control` backbone.
- [`architecture/02-rules-and-workflow.md`](architecture/02-rules-and-workflow.md) — the
  rules-as-data workflow engine: event-triggered rules, the field-validator and action-handler
  registries.
- [`architecture/03-approvals-and-expense.md`](architecture/03-approvals-and-expense.md) — the
  shared approval engine (policies / thresholds / manager-hierarchy / parallel-sequential) and the
  expense lifecycle that consumes it.
- [`architecture/04-services.md`](architecture/04-services.md) — the seven services + gateway +
  cli: responsibilities, routes, events emitted/consumed, access-control highlights.
- [`architecture/05-data-model.md`](architecture/05-data-model.md) — the cross-service data model:
  tables, keys, `tenant_id` + RLS columns, money-as-minor-units, state machines.
- [`architecture/aws-and-providers.md`](architecture/aws-and-providers.md) — the provider-seam
  decision: where cloud SDKs / external providers are abstracted and why.
- [`architecture/code-ownership.md`](architecture/code-ownership.md) — where a given model, table,
  interface, or DTO lives (and the rule that decides).
- [`architecture/process-management.md`](architecture/process-management.md) — the process model:
  per-service images + `PROCESS_TYPE` entrypoint switch, independent service/worker scaling, and the
  PM2-vs-container-runtime decision.

---

## Per-service designs ([`services/`](services/))

One design doc per service: domain model, routes, permissions enforced, events, access-control
highlights.

- [`services/user-management.md`](services/user-management.md) — identity + access system of record
  and Policy Administration Point: tenants, users, memberships, roles, permissions, org hierarchy,
  teams, invites, sessions, reference IdP.
- [`services/expense.md`](services/expense.md) — expense reports + user-entered items (no GL codes),
  categories, multi-level approval, ERP push via `@aegis/connectors`.
- [`services/payroll.md`](services/payroll.md) — highest-sensitivity PII: field-encrypted employees,
  pay runs, payslips, disbursement ledger, tax config; field-level RBAC + masking + maker-checker.
- [`services/reporting.md`](services/reporting.md) — declarative report definitions, scheduling,
  async export; row + column-level access with access-scope baked into every cache key.
- [`services/workflow.md`](services/workflow.md) — the rules-as-data engine and the ERP-sync worker
  that consumes connector-push outbox events.
- [`services/notification.md`](services/notification.md) — in-app + email notifications, templated
  (text + HTML), logged, idempotent; consumes already-authorized events.
- [`services/invoice.md`](services/invoice.md) — header-level invoice lifecycle; "matching" =
  duplicate detection + threshold/variance vs an optional PO ref + approval routing (no line items).
- [`services/connectors.md`](services/connectors.md) — the pluggable ERP framework
  `@aegis/connectors`: connector interface + adapter/registry, the mock connectors (`LedgerOne`,
  `Finovo`, `AcctBridge`), and how to add a new ERP.

---

## API

- [`api/index.html`](api/index.html) — the API reference, rendered fully offline from
  [`api/openapi.yaml`](api/openapi.yaml) (no external network dependency). Source of truth is the
  Aegis controllers + Joi validators.
- [`api/openapi.yaml`](api/openapi.yaml) — the OpenAPI 3.0 spec for all `/{service}/v1/...` routes.
- **Live `/api-docs`** — the gateway serves Swagger UI at <http://localhost:4000/api-docs> and the
  raw OpenAPI document at <http://localhost:4000/api-docs.json> once the stack is running.
- [`postman/Aegis.postman_collection.json`](postman/Aegis.postman_collection.json) — importable
  Postman collection hitting every flow through the gateway.

---

## Testing ([`testing/`](testing/))

- [`testing/TESTING_GUIDE.md`](testing/TESTING_GUIDE.md) — how to run the test suites (unit + the
  Docker-gated live layer) and what each tier covers.
- [`testing/flow-catalogue.md`](testing/flow-catalogue.md) — one entry per user flow across all
  services: what is tested, how, and the expected result.
- [`testing/FLOWS_v2.md`](testing/FLOWS_v2.md) — the Wave 1–3 hardening test plan.
- [`testing/LIVE_E2E_RUNBOOK.md`](testing/LIVE_E2E_RUNBOOK.md) — the runbook for the live dockerized
  end-to-end run (`E2E_BASE_URL` against the stood-up stack).
- [`testing/CURL_EXAMPLES.md`](testing/CURL_EXAMPLES.md) — copy-paste curl commands hitting every
  flow against the gateway.
- [`testing/flow-recording.md`](testing/flow-recording.md) — the per-flow annotated screen-capture
  recording format (what / expected / pass-fail).
- [`../TESTING_PLAN.md`](../TESTING_PLAN.md) — the root testing plan; pairs with the append-only
  [`../BUGLOG.md`](../BUGLOG.md).
- [`flows.html`](flows.html) — the flow-coverage dashboard (open in a browser).

---

## Operations

- [`deployment-topology.md`](deployment-topology.md) — how the platform is packaged and run: one
  image for the whole platform, image promotion, the local one-command run, the cloud showcase.
- [`architecture/process-management.md`](architecture/process-management.md) — the process /
  runtime model and the `PROCESS_TYPE` (api / worker / migration) entrypoint switch.

---

## Reference

The conceptual deep-dives (the numbered `0N-*.md` chapters) plus cross-cutting reference notes.

- [`02-patterns.md`](02-patterns.md) — recurring engineering patterns: Controller → Service →
  Repository → Model layering, InversifyJS DI, Joi validators, error envelope, enum/type/constant
  organization.
- [`03-access-control-model.md`](03-access-control-model.md) — the heart of Aegis: RBAC core + ABAC
  conditions + row-level scope; PDP/PEP/PAP/PIP; dotted `domain.action` permissions; dynamic roles.
- [`access-control-matrix.md`](access-control-matrix.md) — the **who-can-do-what** reference: all 11
  system roles × 57 permissions as a verified grant matrix (Owner/Admin = full catalog; Manager,
  Approver, Contributor, Viewer, PayrollAdmin/Approver, FinanceDisburser, Auditor, Employee scoped).
- [`04-multi-tenancy.md`](04-multi-tenancy.md) — database-enforced tenant isolation: shared-DB
  pooled model, mandatory `tenant_id`, Postgres RLS (`FORCE` + `RESTRICTIVE`, non-owner role,
  `SET LOCAL app.current_tenant`).
- [`05-authn-authz-flow.md`](05-authn-authz-flow.md) — the authn + authz request flow: short-lived
  JWTs, edge validation, per-service re-validation + `aud` check, PEP → PDP decision path.
- [`06-service-to-service.md`](06-service-to-service.md) — internal communication: request-context
  propagation, signed internal JWT + `X-Internal-Origin` gate, strict header validation, token
  exchange.
- [`07-data-models.md`](07-data-models.md) — the full data model across all services: tables, keys,
  relationships, RLS columns, money-as-minor-units, state machines.
- [`08-api-conventions.md`](08-api-conventions.md) — API conventions: REST resource shapes, the
  `{ errors: [...] }` error envelope, `{ data, meta }` list pagination, explicit DTOs, route wrapping.
- [`09-deployment-and-ops.md`](09-deployment-and-ops.md) — deployment & operations: single
  multi-purpose image + `PROCESS_TYPE`, immutable SHA promotion, migrations-as-task,
  health/readiness, one-command local run.
- [`10-auditability-and-compliance.md`](10-auditability-and-compliance.md) — auditability, security
  & compliance: hash-chained tamper-evident audit, field encryption, SoD/maker-checker, retention.
- [`architecture/code-ownership.md`](architecture/code-ownership.md) — the code-ownership rule for
  where each model/table/DTO lives.
- [`architecture/aws-and-providers.md`](architecture/aws-and-providers.md) — the AWS SDK / provider
  seam decision.
- [`interactive/index.html`](interactive/index.html) — a single-page, picture-first walkthrough of
  the architecture, the access-control decision path, and the service topology (open in a browser).

---

## Root docs (repository root)

- [`../SPEC.md`](../SPEC.md) — the authoritative specification and source of truth (including §10
  Amendments). Where any doc disagrees, `SPEC.md` wins.
- [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) — the living build tracker: what is done,
  what remains (final Dockerized acceptance pass + scheduled bug-hunting automation), and the decision log.
- [`../HANDOFF.md`](../HANDOFF.md) — the handoff: current state, how to stand the stack up, and what
  is Docker-gated.
- [`../AGENTS.md`](../AGENTS.md) — conventions and provenance rules for contributors and agents.
- [`../DESIGN.md`](../DESIGN.md) — the consolidated design document (functional + non-functional
  requirements, architecture, flows, diagrams, API examples).
- [`../README.md`](../README.md) — the repository README / enterprise showcase entry point.
- [`../BUGLOG.md`](../BUGLOG.md) — the append-only bug log (all 16 logged bugs fixed).
- [`../TESTING_PLAN.md`](../TESTING_PLAN.md) — the root testing plan.
