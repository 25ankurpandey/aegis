# Aegis — Design Document

Aegis is an enterprise-grade **access-control system for a multi-tenant, microservices SaaS** —
centralized authorization (RBAC + ABAC), database-enforced tenant isolation, secure
service-to-service communication, dynamic role/permission management, and tamper-evident auditing,
designed for thousands of tenants and millions of users.

This document is the front door; each section links to the detailed design under [`docs/`](docs/),
and to the runnable code. The authoritative spec is [`SPEC.md`](SPEC.md); live build status is
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

---

## 1. Functional & non-functional requirements

**Functional.** Seven business services on one access-control substrate — **User Management**
(identity, the IdP, and the Policy Administration Point), **Expense**, **Payroll**, **Reporting**,
**Workflow**, **Notification**, **Invoice** — plus a **Gateway** and a **CLI**. Each tenant has its
own users, organizational structure, roles, permissions, and policies. The platform supports
authentication, fine-grained authorization, tenant isolation, cross-service authorization,
service-to-service security, dynamic role/permission management, and auditability.

**Non-functional.** Tenant isolation that an application bug cannot breach (DB-enforced RLS);
fail-closed authorization; short-lived tokens; horizontal scalability (stateless services, one
image, autoscaling); observability (structured logs + correlation ids); SOC2/GDPR-aligned
tamper-evident audit. See [`docs/01-architecture.md`](docs/01-architecture.md).

## 2. High-level architecture

An **Nx monorepo**: `apps/*` are deployable services, `libs/*` are shared. Every service is
internally layered Controller → Service → Repository → Model with **InversifyJS** DI, and shares
`@aegis/service-core` (context, logging, errors, HTTP client), `@aegis/access-control` (the
PDP/PEP), `@aegis/db` (RLS), `@aegis/events` (bus), `@aegis/connectors` (ERP), and
`@aegis/audit`. Request path: **Gateway → context + header validation → authenticate → authorize
(PDP) → RLS-scoped query → handler → audit + events**. Full diagrams:
[`docs/01-architecture.md`](docs/01-architecture.md).

## 3. Authentication & authorization flow

OIDC/OAuth2 with short-lived RS256/ES256 JWTs (HS256 for the local reference IdP); the gateway
validates at the edge and **each service re-validates** (defense in depth). Authorization is a
**PDP/PEP** split: every route is `authenticate() → authorize(permission)`; the PDP decides from
RBAC + ABAC + row-level scope, fail-closed. See
[`docs/05-authn-authz-flow.md`](docs/05-authn-authz-flow.md) and
[`docs/03-access-control-model.md`](docs/03-access-control-model.md).

## 4. Multi-tenant isolation

Pooled model (shared schema + `tenant_id`) with **PostgreSQL Row-Level Security** as the
enforcement layer: `FORCE` + `RESTRICTIVE` policies keyed on `current_setting('app.current_tenant')`,
the app running as a **non-owner role without BYPASSRLS**, and the tenant set per-transaction with
`set_config(..., true)`. Belt-and-suspenders: app-layer scoping **and** DB RLS. A premium silo tier
(schema/DB-per-tenant) is offered for regulated tenants (Payroll first). See
[`docs/04-multi-tenancy.md`](docs/04-multi-tenancy.md).

## 5. Access-control model

**RBAC core + ABAC conditions + row-level scope.** Permissions are dotted `domain.action` strings
in a catalog; roles map to permissions via an explicit join (single source of truth); roles,
permissions, and assignments are managed at **runtime via the PAP** (no migration/deploy). ABAC
policies refine decisions (e.g. "approver can approve expenses in own tenant up to $X"); row-level
scope (`AllRecords`/`OwnAndTeam`/`OwnOnly`) compiles to predicates + RLS. Maker-checker /
segregation-of-duties is enforced in Payroll. Alternatives (Casbin/OPA/Cerbos/OpenFGA) and when to
add ReBAC are discussed in [`docs/03-access-control-model.md`](docs/03-access-control-model.md).

## 6. Service-to-service security

mTLS-ready transport identity + a **signed internal JWT** (issuer/audience/exp) gated by an
`X-Internal-Origin` header and a propagated `X-Source-Service` for audit attribution; end-user
context (`X-Tenant-Id`, `X-Correlation-Id`, `X-Trace-Id`) propagates on every hop via the
context-propagating HTTP client and event envelopes. No ambient authority. See
[`docs/06-service-to-service.md`](docs/06-service-to-service.md).

## 7. APIs & data models

REST with a uniform error envelope, pagination, idempotency keys on money/state writes, and
`authenticate → authorize` on every protected route. Full API examples:
[`docs/08-api-conventions.md`](docs/08-api-conventions.md). Complete schema (identity/access,
approval, expense, invoice, workflow, payroll, notification, reporting, connectors, audit) with ER
diagrams: [`docs/07-data-models.md`](docs/07-data-models.md). Schema is created by the numbered
migrations in [`apps/cli/src/migrations`](apps/cli/src/migrations) with RLS on every tenant table.

## 8. Scalability & reliability

Stateless services behind the gateway; one image, autoscaled (Cloud Run min/max); PDP decisions are
cacheable with a short TTL (fail-closed); the event bus uses a transactional outbox; RLS is indexed
with `tenant_id` leading. Reporting is CQRS-lite (read models). See
[`docs/01-architecture.md`](docs/01-architecture.md) and
[`docs/09-deployment-and-ops.md`](docs/09-deployment-and-ops.md).

## 9. Security & compliance

Hash-chained, append-only **audit log** capturing actor, tenant, action, outcome, resource, and
**permissions-at-time-of-action** (`@aegis/audit`, with `verifyChain` tamper detection); field-level
AES-256-GCM encryption for payroll PII; SoD/maker-checker; SOC2/GDPR posture (encryption, audit,
silo tier for residency/erasure). See
[`docs/10-auditability-and-compliance.md`](docs/10-auditability-and-compliance.md).

## 10. Operational concerns

Single multi-purpose image + `PROCESS_TYPE` (api/worker/migration); immutable SHA-image promotion;
migrations as a one-shot task; runtime secrets from a param store; `/health` readiness probing
DB+cache; OpenTelemetry + correlation-id logs. **One-command local run** (`scripts/dev-up.sh` /
VS Code Cmd+Shift+B) and **one-`terraform apply`** cloud provisioning ([`infra/terraform`](infra/terraform)).
See [`docs/09-deployment-and-ops.md`](docs/09-deployment-and-ops.md).

---

## Deliverables map

| Required | Where |
|---|---|
| Functional + non-functional requirements | §1 · [`docs/01-architecture.md`](docs/01-architecture.md) |
| High-level architecture | §2 · [`docs/01-architecture.md`](docs/01-architecture.md) · [interactive](docs/interactive/index.html) |
| Authn/authz flow | §3 · [`docs/05-authn-authz-flow.md`](docs/05-authn-authz-flow.md) |
| Multi-tenant isolation | §4 · [`docs/04-multi-tenancy.md`](docs/04-multi-tenancy.md) |
| Access-control model | §5 · [`docs/03-access-control-model.md`](docs/03-access-control-model.md) |
| Service-to-service security | §6 · [`docs/06-service-to-service.md`](docs/06-service-to-service.md) |
| APIs & data models | §7 · [`docs/08-api-conventions.md`](docs/08-api-conventions.md) · [`docs/07-data-models.md`](docs/07-data-models.md) |
| Scalability & reliability | §8 |
| Security & compliance | §9 · [`docs/10-auditability-and-compliance.md`](docs/10-auditability-and-compliance.md) |
| Operations (monitoring/audit/debug) | §10 · [`docs/09-deployment-and-ops.md`](docs/09-deployment-and-ops.md) |
| Diagrams / sequence / schema | throughout `docs/` (Mermaid) + [interactive HTML](docs/interactive/index.html) |
| Per-service designs | [`docs/services/`](docs/services/) |
| Testing & flow catalogue | [`TESTING_PLAN.md`](TESTING_PLAN.md) · [`docs/testing/flow-catalogue.md`](docs/testing/flow-catalogue.md) |
