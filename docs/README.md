# Aegis Documentation

This is the documentation index for **Aegis** — an enterprise access-control system for a
multi-tenant, microservices-based SaaS platform. Seven business services (`user-management`,
`expense`, `payroll`, `reporting`, `workflow`, `notification`, `invoice`) plus a `gateway` and a
`cli`, all sharing a central access-control library on an Nx monorepo, with tenant isolation
enforced in **PostgreSQL via Row-Level Security**.

The authoritative source of truth is [`../SPEC.md`](../SPEC.md) (including **§10 Amendments —
2026-06-26**). The conventions and provenance rules for contributors and agents are in
[`../AGENTS.md`](../AGENTS.md). Current build status lives in
[`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md). Where any document disagrees with
`SPEC.md`, **`SPEC.md` wins** — and where `SPEC.md` §10 disagrees with §0–§9, **§10 wins**.

---

## How the docs map to the platform's concerns

The numbered docs are ordered to walk a reader from "what and why" to "how it runs in production".
Each concern an enterprise reviewer cares about has a home:

- **Functional + non-functional requirements** — the *what* (the seven services and their
  responsibilities) is summarized in [`01-architecture.md`](01-architecture.md) and detailed per
  service under [`services/`](services/); the *how well* (isolation, scalability, security,
  operability) is threaded through [`04-multi-tenancy.md`](04-multi-tenancy.md),
  [`09-deployment-and-ops.md`](09-deployment-and-ops.md), and
  [`10-auditability-and-compliance.md`](10-auditability-and-compliance.md).
- **Architecture** — the monorepo topology, the `apps/*` deployables vs `libs/*` shared libraries
  split, and the cross-cutting backbone (`@aegis/service-core`) are in
  [`01-architecture.md`](01-architecture.md), with the recurring implementation idioms in
  [`02-patterns.md`](02-patterns.md).
- **Authentication & authorization flow** — short-lived RS256/ES256 JWTs, edge validation at the
  gateway, per-service re-validation via JWKS, and the PDP/PEP request path are in
  [`05-authn-authz-flow.md`](05-authn-authz-flow.md).
- **Multi-tenant isolation** — the shared-DB pooled model, mandatory `tenant_id`, and the
  `FORCE`/`RESTRICTIVE` Postgres RLS strategy (app runs as a non-owner without `BYPASSRLS`,
  `SET LOCAL app.current_tenant` per transaction) are in
  [`04-multi-tenancy.md`](04-multi-tenancy.md).
- **Access-control model** — the RBAC core + ABAC conditions + row-level scope engine, the
  PDP/PEP/PAP/PIP split, and the dotted `domain.action` permission vocabulary are in
  [`03-access-control-model.md`](03-access-control-model.md).
- **Service-to-service security** — request-context propagation (`X-Tenant-Id`,
  `X-Correlation-Id`, `X-Trace-Id`, `X-Caller`, `X-Source-Service`), the signed internal JWT with
  the `X-Internal-Origin` gate, strict fail-closed header validation, and RFC 8693 token exchange
  are in [`06-service-to-service.md`](06-service-to-service.md).
- **APIs + data models** — the request/response envelope, pagination, error contract, and DTO
  conventions are in [`08-api-conventions.md`](08-api-conventions.md); the full schema (tables,
  keys, RLS columns) is in [`07-data-models.md`](07-data-models.md).
- **Scalability & reliability** — the PDP decision cache, the read-side CQRS-lite reporting model,
  async export workers, and autoscaling targets are covered across
  [`03-access-control-model.md`](03-access-control-model.md),
  [`services/reporting.md`](services/reporting.md), and
  [`09-deployment-and-ops.md`](09-deployment-and-ops.md).
- **Security & compliance** — tamper-evident hash-chained audit, field-level encryption,
  segregation of duties / maker-checker, and retention are in
  [`10-auditability-and-compliance.md`](10-auditability-and-compliance.md).
- **Operations** — the single multi-purpose Docker image with the `PROCESS_TYPE` entrypoint
  switch, immutable SHA-image promotion, health/readiness probes, the local one-command run, and
  the Terraform cloud showcase are in [`09-deployment-and-ops.md`](09-deployment-and-ops.md) and
  [`research/terraform-iac.md`](research/terraform-iac.md).

A picture-first overview is available as the [interactive walkthrough](interactive/index.html), and
the rendered Mermaid sources live under [`diagrams/`](diagrams/).

---

## Core docs (read in order)

| # | Doc | What it covers |
|---|-----|----------------|
| 01 | [`01-architecture.md`](01-architecture.md) | System architecture: Nx monorepo, `apps/*` deployables vs `libs/*` shared, the seven services + gateway + cli, the `@aegis/service-core` / `@aegis/access-control` backbone, request lifecycle. |
| 02 | [`02-patterns.md`](02-patterns.md) | Recurring implementation patterns: Controller → Service → Repository → Model layering, InversifyJS DI (`@provideSingleton`), Joi validators, error envelope, enum/type/constants organization. |
| 03 | [`03-access-control-model.md`](03-access-control-model.md) | The heart of Aegis: RBAC core + ABAC conditions + row-level scope; PDP/PEP/PAP/PIP; dotted `domain.action` permissions; dynamic roles; the decision cache. |
| 04 | [`04-multi-tenancy.md`](04-multi-tenancy.md) | Database-enforced tenant isolation: shared-DB pooled model, mandatory `tenant_id`, Postgres RLS (`FORCE` + `RESTRICTIVE`, non-owner role, `SET LOCAL app.current_tenant`), silo premium tier. |
| 05 | [`05-authn-authz-flow.md`](05-authn-authz-flow.md) | Authn + authz request flow: short-lived JWTs, edge validation, per-service token re-validation + `aud` check, session-based revocation hook, PEP → PDP decision path. |
| 06 | [`06-service-to-service.md`](06-service-to-service.md) | Internal communication: request-context propagation, `X-Correlation-Id` semantics, signed internal JWT + `X-Internal-Origin` gate + `X-Source-Service`, strict header validation, RFC 8693 token exchange. |
| 07 | [`07-data-models.md`](07-data-models.md) | The full data model across all services: tables, keys, relationships, `tenant_id` + RLS columns, money-as-minor-units, state machines. (Invoice is header-level; no GL codes / line items.) |
| 08 | [`08-api-conventions.md`](08-api-conventions.md) | API conventions: REST resource shapes, the `{ errors: [...] }` error envelope, `{ data, meta }` list pagination, explicit DTOs, `authenticate → authorize → handler` route wrapping. |
| 09 | [`09-deployment-and-ops.md`](09-deployment-and-ops.md) | Deployment & operations: single multi-purpose image + `PROCESS_TYPE` switch, immutable SHA promotion, migrations-as-task, health/readiness, observability, **one-command local run**. |
| 10 | [`10-auditability-and-compliance.md`](10-auditability-and-compliance.md) | Auditability, security & compliance: hybrid append-only activity feed + per-domain audit tables, hash-chained tamper-evidence, field encryption, SoD/maker-checker, retention, SOC2/GDPR posture. |

---

## Per-service designs ([`services/`](services/))

One design doc per deployable. Each documents its domain model, routes, the permissions it
enforces, the events it emits/consumes, and its access-control highlights.

| Service | Doc | Focus |
|---------|-----|-------|
| user-management | [`services/user-management.md`](services/user-management.md) | Identity + access system of record and Policy Administration Point: tenants, users, memberships, roles, permissions, org hierarchy, teams, invites, sessions, reference IdP. |
| expense | [`services/expense.md`](services/expense.md) | Expense reports + user-entered items (no GL codes / extracted line items), categories, multi-level approval, ERP push via `@aegis/connectors`. Ported from a Python/FastAPI reference to Node/TS. |
| payroll | [`services/payroll.md`](services/payroll.md) | Highest-sensitivity PII: employees (field-encrypted), pay runs, payslips, disbursement ledger, jurisdiction tax config; field-level RBAC + masking and maker-checker. |
| reporting | [`services/reporting.md`](services/reporting.md) | CQRS-lite read models, declarative report definitions, scheduling, async export; row + column-level access with access-scope baked into every cache key. |
| workflow | [`services/workflow.md`](services/workflow.md) | Rules-as-data engine (conditions + actions) triggered by domain events; the field-validator and action-handler registries. |
| notification | [`services/notification.md`](services/notification.md) | In-app + email notifications, templated, logged, idempotent; consumes already-authorized events and never re-derives authority. |
| invoice | [`services/invoice.md`](services/invoice.md) | Header-level invoice lifecycle/state machine; "matching" = duplicate detection + threshold/variance vs an optional PO reference + approval routing (no line items / GL codes). |
| gateway | [`services/gateway.md`](services/gateway.md) | Edge: JWT validation, routing, rate limiting, `X-Correlation-Id` minting, token exchange. |
| connectors | [`services/connectors.md`](services/connectors.md) | The pluggable ERP framework `@aegis/connectors`: connector interface + adapter/strategy + registry, the mock connectors (`LedgerOne`, `Finovo`, `AcctBridge`), and how to add a new ERP with one adapter. |

---

## Research & design notes ([`research/`](research/))

Distilled analysis and design rationale that informed the locked decisions, plus deliverables that
are intentionally analysis-only for now.

| Doc | What it covers |
|-----|----------------|
| [`research/service-core.md`](research/service-core.md) | The `@aegis/service-core` design: RequestContext (AsyncLocalStorage), logger, error utils/envelope, context-propagating HTTP client, config/secrets, cache adapter, and the validated context middleware. |
| [`research/connectors.md`](research/connectors.md) | The pluggable ERP connector framework rationale: why a common interface + adapter/strategy + per-connector config, and how mock connectors prove production-readiness without calling real ERPs. |
| [`research/terraform-iac.md`](research/terraform-iac.md) | The showcase cloud IaC plan: `infra/terraform/` (env/{dev,prod} + modules/) — compute, Pub/Sub event bus, autoscaling (min/max), network + NAT, monitoring/alerts. |
| [`research/frontend-analysis.md`](research/frontend-analysis.md) | **Analysis only (no build yet):** whether a lightweight UI is worth adding to showcase every flow — options, effort, recommendation. Owner reviews before any build. |

---

## Testing & flows ([`testing/`](testing/))

The end-to-end flow catalogue and how runs are documented, authored *before* the test
implementation.

| Doc | What it covers |
|-----|----------------|
| [`testing/flow-catalogue.md`](testing/flow-catalogue.md) | One entry per user flow across all services: what is being tested, how to test it, expected results, and the annotation/recording format. Pairs with the root [`../TESTING_PLAN.md`](../TESTING_PLAN.md) and the append-only [`../BUGLOG.md`](../BUGLOG.md). |

---

## Interactive walkthrough

- [`interactive/index.html`](interactive/index.html) — a single-page, picture-first walkthrough of
  the architecture, the access-control decision path, and the service topology. Open it in a
  browser; it stays in sync with the architecture docs and the diagrams under
  [`diagrams/`](diagrams/).

---

## Start here — reading orders

**Newcomer (understand the platform):**
[`01-architecture.md`](01-architecture.md) →
[`03-access-control-model.md`](03-access-control-model.md) →
[`04-multi-tenancy.md`](04-multi-tenancy.md) →
[`05-authn-authz-flow.md`](05-authn-authz-flow.md) →
the [interactive walkthrough](interactive/index.html) →
the service docs you care about under [`services/`](services/).

**Reviewer (assess depth, security, distributed-systems soundness):**
[`../SPEC.md`](../SPEC.md) (skim, then **§10**) →
[`03-access-control-model.md`](03-access-control-model.md) →
[`06-service-to-service.md`](06-service-to-service.md) →
[`04-multi-tenancy.md`](04-multi-tenancy.md) →
[`10-auditability-and-compliance.md`](10-auditability-and-compliance.md) →
[`07-data-models.md`](07-data-models.md) +
[`08-api-conventions.md`](08-api-conventions.md) →
[`09-deployment-and-ops.md`](09-deployment-and-ops.md) →
the per-service highlights under [`services/`](services/).

**Agent / contributor (pick up a build task):**
[`../AGENTS.md`](../AGENTS.md) (every time, first) →
[`../SPEC.md`](../SPEC.md) (authoritative; **§10** is current scope) →
the [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) phase you are picking up →
the relevant doc above →
[`02-patterns.md`](02-patterns.md) +
[`08-api-conventions.md`](08-api-conventions.md) for conventions to follow.
Keep `IMPLEMENTATION_PLAN.md` and any doc you touch updated in the same change.
