# Aegis — Canonical Specification (Single Source of Truth)

> This file is the authoritative spec for the Aegis platform. Every other document
> (`AGENTS.md`, `IMPLEMENTATION_PLAN.md`, `docs/**`) and every agent MUST be consistent
> with this file. If a decision conflicts, **this file wins** — update it deliberately,
> then propagate. Last updated: 2026-06-25.

---

## 0. What Aegis is

**Aegis** is an enterprise-grade **Access Control System for a multi-tenant, microservices-based SaaS platform** — centralized authorization (RBAC + ABAC, PDP/PEP), database-enforced tenant isolation, secure service-to-service communication, dynamic role/permission management, and tamper-evident auditing, across many services and many tenants.

The platform hosts seven business services and a shared access-control substrate:

| # | Service | Responsibility |
|---|---------|----------------|
| 1 | **user-management** | Tenants, users, memberships, roles, permissions, org hierarchy, teams, invitations, sessions, auth token issuance. The identity + access **system of record** and Policy Administration Point (PAP). |
| 2 | **expense** | Expense reports, line items, categories/GL codes, receipts, multi-level approval, ERP sync. (Ported from a Python/FastAPI reference into Node/TS.) |
| 3 | **payroll** | Employees, compensation, pay calendars, earning/deduction codes, jurisdiction-keyed tax config, pay runs, payslips, disbursement ledger. Highest-sensitivity PII. |
| 4 | **reporting** | Cross-service read models, declarative report definitions, scheduling, async export. CQRS-lite read side. |
| 5 | **workflow** | Rules-as-data engine (conditions + actions), triggered by domain events. |
| 6 | **notification** | In-app + email notifications, templated, logged, idempotent. |
| 7 | **invoice** | Invoice lifecycle/state machine, line items, matching, invoice metadata, approval binding. |

Plus supporting apps: **gateway** (edge: token validation + routing), **cli** (migrations/ops).

### Naming / brand rules (HARD CONSTRAINT)
Use only the `@aegis/*` scope and Aegis domain names. The codebase MUST NOT reference any external reference codebase, its internal packages, or its customers by name anywhere. The npm scope is `@aegis/*`. Service/header/table names use neutral, domain-accurate terms. External codebases are **references only**; nothing is copied verbatim with branding.

---

## 1. Locked decisions (with rationale)

| Decision | Choice | Rationale |
|---|---|---|
| **Repo topology** | **Nx monorepo** | Lets all 7 services share ONE access-control lib + enums/types; mirrors the superior domain-reference structure. |
| **Build scope** | **All 7 services built fully** | Demonstrate access control end-to-end across every service. |
| **Per-service internals** | **service-template-reference pattern** — Express + InversifyJS DI (`controllers/services/repositories/interfaces/models/validators/constants/ioc`), Joi validation, central error middleware | Clean, layered, testable. |
| **Cross-cutting lib** | **`@aegis/service-core`** — a clean OSS replacement for the architecture reference's proprietary service-util package | The reference backbone (logger/context/auth/http/secrets) is closed-source and unavailable; we re-implement its *patterns*. |
| **Access-control model** | **In-house RBAC + ABAC engine** with explicit **PDP/PEP** split; dotted `domain.action` permission vocabulary; **dynamic** roles/permissions (runtime CRUD); per-tenant scoping in the engine | The architecture reference's authz is closed-source; the domain reference's Casbin is neutered (`dom='*'`) and migration-only. We build it right. ReBAC (OpenFGA) documented as an extension for relationship-heavy cases. |
| **Datastore** | **PostgreSQL** + Sequelize (the architecture reference's connection/adapter pattern, on Postgres) | Enables **Row-Level Security** for DB-enforced tenant isolation — central to this platform. |
| **Tenant isolation** | Shared-DB pooled model: mandatory `tenant_id` on every row + **Postgres RLS** (`FORCE ROW LEVEL SECURITY`, `RESTRICTIVE` policy, app runs as non-owner without `BYPASSRLS`, `SET LOCAL app.current_tenant` per transaction) | Defense-in-depth; an app bug cannot leak cross-tenant data. Silo (schema/DB-per-tenant) offered as a premium tier (Payroll first candidate). |
| **Enums & types** | **domain-reference pattern** — flat `@aegis/shared-enums` (one `<domain>.enum.ts` + barrel, `*Display` map idiom), `@aegis/shared-types` `<domain>.shape.ts` namespaces, centralized `HttpHeaderKey` + table-name enums | Established, well-organized pattern. |
| **Constants** | **service-template-reference pattern** — per-area `Constants` classes in `@aegis/shared-constants` | Established, single-source pattern. |
| **Migrations** | **Umzug code-first** numbered migrations (`NNNN_subject.ts` with `{name, up, down}`), run as a one-shot task; **NOT** `sequelize.sync()` | The domain reference's approach is production-grade; the architecture reference's runtime sync is unsafe. |
| **Deployment** | **domain-reference model** — single multi-purpose Docker image + `PROCESS_TYPE` (api/worker/migration) entrypoint switch, immutable SHA-image promotion, runtime secrets from a param store, DRY CI with YAML anchors | Confirmed superior for a multi-service platform; de-branded. |
| **Event bus** | Abstracted `@aegis/events` publish/consume registry (topic enum → handler), inline-when-sync / queue-when-async toggle; transactional outbox semantics | Follows the domain reference's PublishMap/consumer pattern; transport-swappable (Redis/SQS/Kafka). |
| **Audit** | Hybrid — generic append-only **activity feed** + per-domain audit tables; **hash-chained** tamper-evident entries; capture actor, tenant, intent, decision, permissions-at-time-of-action | Domain-reference pattern + SOC2/GDPR best practice. |
| **Service-to-service** | Request-context header propagation (`X-Tenant-Id`, `X-Caller`, correlation/trace id, entry-context) per the architecture reference + signed internal JWT (issuer/audience/exp) gated by an origin header + a propagated source-service header; mTLS-ready | Best of both references + closes the ambient-authority gap. |

---

## 2. Access-control model (the heart of Aegis)

### 2.1 Vocabulary
- **Tenant** — an organization (the isolation boundary). Every row carries `tenant_id`.
- **User** — a principal. A user joins a tenant via a **Membership** (unique per `(user_id, tenant_id)`) with an `active_workspace` flag → deterministic "current tenant + current role" per request.
- **Role** — a named bundle of permissions. System roles are seeded; tenants may define **custom roles** (`tenant_id` non-null). Runtime CRUD supported (PAP).
- **Permission** — a dotted `domain.action` string (e.g. `expense.report.approve`, `payroll.payslip.read`, `role.assign`). Stored in a catalog table; assignable to roles via an explicit `role_permissions` join (NOT a policy-engine grouping hack — single source of truth).
- **Policy / access rule (ABAC)** — conditions evaluated against attributes: subject (role, team, ownership, manager-of), resource (owner, tenant, amount, status, sensitivity), environment (time, IP). Expressed as declarative rules, evaluated by the PDP.
- **Scope (row-level)** — e.g. `AllRecords | OwnAndTeam | OwnOnly`, plus team/hierarchy membership; compiled into query predicates + RLS.

### 2.2 PDP / PEP / PAP / PIP (the four standard points)
- **PDP (Policy Decision Point)** — `@aegis/access-control` evaluates `decide(principal, action, resource, context) → { allow, reason, obligations }`. Pure, cacheable, fail-closed.
- **PEP (Policy Enforcement Point)** — Express middleware/guards in each service: `authorize(permission, { resourceLoader })`. Calls the PDP, enforces the verdict, applies obligations (e.g. column masking).
- **PAP (Policy Administration Point)** — user-management exposes runtime CRUD for roles, permissions, role-permission mappings, and policies.
- **PIP (Policy Information Point)** — supplies attributes the PDP needs (role, memberships, hierarchy, resource attributes); cached.

### 2.3 Model = RBAC core + ABAC conditions + row-level scope
1. **RBAC** answers "does the principal's role grant `action`?" — fast table lookup of `role → permissions`, cached.
2. **ABAC** refines with conditions ("approver can approve expenses in own tenant up to $X", "manager sees their cost-center"). Conditions are data, evaluated by the PDP.
3. **Row-level scope** is enforced twice (belt-and-suspenders): compiled into query predicates AND backstopped by Postgres RLS keyed on `app.current_tenant` (+ optional `app.current_user` for per-user policies).

### 2.4 Authn
- Central IdP issues short-lived **RS256/ES256 JWTs**; claims carry `sub`, `tenant_id`, `roles`, `aud` (per-service audience), `exp`.
- **gateway** validates at the edge; **each service re-validates** via JWKS (defense-in-depth) and checks `aud`.
- Server-side session validation (token row active) is supported for instant revocation.
- Aegis ships a reference IdP inside **user-management** for local/self-contained operation (pluggable: Keycloak/Auth0/Cognito adapters documented).

### 2.5 Per-service access-control highlights
- **payroll**: granular field-level RBAC + masking (salary/bank/national-id encrypted, AES-256); **segregation of duties / maker-checker** (the run approver must differ from the input editor); audit every sensitive-field read.
- **reporting**: row + column-level on report output; access-scope is part of every cache key (no cross-user leakage); never bypass RLS.
- **workflow / approvals**: relationship-shaped (approval chains) — first candidate for ReBAC extension; delegated tokens (`sub`+`act`) for audit.
- **notification**: consumes already-authorized events; never re-derives authority (guards ambient authority).

---

## 3. Monorepo layout

```
aegis/
├── apps/
│   ├── user-management/   # Identity + PAP: tenants, users, memberships, roles, permissions, org hierarchy, teams, invites, sessions, IdP
│   ├── expense/           # Expense reports, approvals, ERP sync (ported from Python reference)
│   ├── payroll/           # Employees, pay runs, payslips, disbursement ledger, tax config
│   ├── reporting/         # CQRS-lite read models, report defs, scheduling, export
│   ├── workflow/          # Rules-as-data engine + action handlers
│   ├── notification/      # In-app + email, templated, idempotent
│   ├── invoice/           # Invoice lifecycle, line items, matching, approval binding
│   ├── gateway/           # Edge: JWT validation, routing, rate limit, token exchange
│   └── cli/               # Migrations / seeders / ops (PROCESS_TYPE=migration)
│
├── libs/
│   ├── service-core/      # Replacement for the architecture reference's service-util:
│   │                      #   RequestContext (AsyncLocalStorage), Logger, ErrorUtils + envelope,
│   │                      #   HttpClient (context-propagating), Config/Secrets, CacheAdapter,
│   │                      #   middleware (context, auth, error, audit), bootstrap helpers
│   ├── access-control/    # PDP: RBAC engine, ABAC policy eval, permission catalog,
│   │                      #   PEP guards/middleware (authorize), obligations (masking)
│   ├── shared/
│   │   ├── enums/         # @aegis/shared-enums — one <domain>.enum.ts per domain + barrel, HttpHeaderKey, TableName
│   │   ├── types/         # @aegis/shared-types — <domain>.shape.ts namespaces (Attributes, kwargs, func-types)
│   │   └── constants/     # @aegis/shared-constants — per-area Constants classes (context paths, hosts-as-env-names)
│   ├── db/                # Sequelize: connection/adapter (per-tenant pattern), DatabaseContext registry,
│   │                      #   Umzug migrations + seeders, RLS helpers (SET LOCAL), transaction helper
│   ├── events/            # Event bus: publish/consume registry, topic enums, outbox, transport adapters
│   └── testing/           # Test utils: context stubs, PDP stubs, fixtures
│
├── docs/                  # Architecture, patterns, model, multi-tenancy, s2s, deployment, per-service, interactive HTML
├── scripts/start.sh       # PROCESS_TYPE switch: api | worker | migration
├── Dockerfile             # single multi-purpose image
├── docker-compose.yml     # local: postgres + redis (+ services)
├── .gitlab-ci.yml         # DRY anchors, build-once SHA image + promote, deploy fan-out
├── nx.json tsconfig.base.json package.json
├── SPEC.md AGENTS.md IMPLEMENTATION_PLAN.md README.md
```

### Per-service internal layout (every `apps/<svc>/src`)
```
src/
├── index.ts            # thin entry: reflect-metadata, env, telemetry, → bootstrap
├── bootstrap.ts        # composition root: build app, middleware chain, connect DB/cache/bus
├── ioc/                # Inversify container + provideSingleton + loader
├── controllers/        # @controller + @httpGet/Post/... (inversify-express-utils)
├── services/           # @provideSingleton business logic; extends BaseService
├── repositories/       # @provideSingleton DALs; Sequelize via DatabaseContext + tenant from RequestContext
├── models/             # Sequelize model definitions (registered into @aegis/db context)
├── interfaces/         # pure TS contracts (typing only, not DI tokens)
├── validators/         # Joi schemas
└── constants/          # service-local Constants
```

---

## 4. Tech stack

- **Language/runtime**: TypeScript (current LTS, e.g. Node 22), strict mode.
- **HTTP**: Express 4 via `inversify-express-utils`; **InversifyJS** DI (`inversify-binding-decorators`).
- **ORM/DB**: Sequelize 6 + `pg` (**PostgreSQL 15+**); Umzug migrations.
- **Cache/queue**: Redis (`ioredis`); BullMQ for scheduled/async jobs (reporting exports, workflow).
- **Validation**: Joi (request) + yup-style shape validators where helpful.
- **Auth**: `jsonwebtoken` + JWKS (RS256/ES256); pluggable IdP adapters.
- **AuthZ**: in-house `@aegis/access-control` (RBAC+ABAC). Documented alternatives: OPA/Cerbos (stateless PDP), OpenFGA/SpiceDB (ReBAC), CASL (in-process).
- **Eventing**: abstracted bus; default transport Redis streams / BullMQ locally, SQS/SNS or Kafka in prod.
- **Observability**: OpenTelemetry (traces/metrics/logs), structured logging (pino), health endpoints.
- **Testing**: Jest (+ ts-jest); supertest for HTTP; per-lib unit tests; coverage gates.
- **Build/deploy**: Nx (affected builds + cache), Docker multi-stage single image, GitLab CI, ECS/K8s target.

---

## 5. Data model (high level — see docs/07-data-models.md for full)

**Identity / access (user-management):** `tenants`, `users`, `memberships(user_id,tenant_id,active_workspace)`, `roles(tenant_id nullable)`, `permissions(name unique)`, `role_permissions`, `user_roles(user_id,tenant_id,role_id,scope)`, `policies(rule json)`, `teams`, `team_members`, `org_units`, `user_hierarchy(manager_id, approval_limit)`, `invites`, `sessions/auth_tokens`, `audit_log`.

**Expense:** `expense_reports(status state machine)`, `expenses`, `expense_categories`, `expense_approvals`, `expense_comments`, `expense_activities`. **No GL codes and no document-extracted line items** (we have no extraction pipeline). An `expense` row is a user-entered item under a report — not an extracted line item.

**Payroll:** `employees(*_enc fields)`, `employment_contracts`, `pay_calendars`, `earning_codes`, `deduction_codes`, `tax_rules(jurisdiction, effective_dated)`, `employee_pay_items`, `pay_runs(status)`, `payslips`, `payslip_lines`, `payroll_input_items(idempotency_key)`, `payments`, `payment_batches`, `ledger_entries(append-only)`.

**Invoice:** `invoices(status, header-level)`, `invoice_metadata`, `invoice_duplicates`, `invoice_approvals`, `invoice_activities`. **Header-level only — no line items, no GL codes, NO PO reference, and NO matching/threshold/variance** (not in scope). The only reconciliation is a lightweight **duplicate-entry guard** (same tenant + vendor + invoice_number + amount) to avoid paying the same invoice twice; the core flow is the status lifecycle + multi-level approval.

**Workflow:** `rules`, `rule_steps(query jsonb: {field,operator,value,conjunction})`, `rule_actions`, `rule_audit_logs`.

**Approval (shared, used by expense/invoice/payroll):** `approval_policies`, `approval_hierarchy(level)`, `approver_groups`, `approver_group_members(user|role|team|persona)`, `record_approvers(threshold)`, `approvals`, `approval_progress_log`.

**Notification:** `notifications`, `email_notification_logs(status)`.

**Reporting:** `report_definitions(spec json)`, `report_schedules`, `report_runs(status,artifact_url)`, `report_access_policies(allowed_columns, masked_columns, row_filter)`, fact tables (`fact_expense/invoice/payroll/approval`) + dimensions + materialized rollups.

All tenant-scoped tables: `tenant_id NOT NULL` + RLS.

---

## 6. Service-to-service & context propagation

- **Request context** (`@aegis/service-core`, AsyncLocalStorage) carries: `tenantId`, `userId`, `roles`, `correlationId`, `caller`, `sourceService`. Populated from headers on HTTP ingress and from message headers on event ingress, with **strict header validation**: required headers are asserted by the context middleware; missing/malformed values are rejected **fail-closed** (never defaulted to "UNKNOWN"). There is **no `entryContext`** (a reference-domain concept — dropped).
- **`X-Correlation-Id` is THE single request-tracking id.** Minted at the edge (gateway) per inbound request, **required on every internal hop** (`REQUIRED_INTERNAL_HEADERS`), validated by the context middleware, propagated unchanged through every downstream call + async message, and stamped on every log line and error envelope (as `correlationId`). **We deliberately do not also carry `X-Trace-Id`** — it would be redundant with the correlation id. If/when distributed tracing is added, the OpenTelemetry SDK carries trace context via the standard W3C `traceparent` header (managed by the SDK, not hand-rolled by us). No `X-Trend`/`X-Tracker` header exists.
- **Outbound calls** propagate headers: `X-Tenant-Id`, `X-Correlation-Id`, `X-Caller`, `X-Source-Service`, `X-Internal-Origin`, `X-Internal-Token`, plus the user token.
- **Internal auth**: signed internal JWT (issuer/audience/exp, NOT empty-payload) + an origin header gate (`X-Internal-Origin`) + propagated `X-Source-Service` (typed enum) for audit attribution. mTLS/SPIFFE-ready.
- **Token exchange** (RFC 8693): downscope + re-audience tokens for internal hops; prefer delegation (`sub`+`act`) over impersonation.

---

## 7. Deployment & ops (de-branded domain-reference model)

- **One image, many roles**: `Dockerfile` builds the whole monorepo `dist/`; `scripts/start.sh` switches on `PROCESS_TYPE` → `api` (the selected `SERVICE_NAME` app), `worker`, or `migration`.
- **Immutable SHA images**: build once, tag `:$GIT_SHA`, promote across envs by re-tagging (no rebuild).
- **Migrations as a one-shot task** using the same image (`PROCESS_TYPE=migration`).
- **Runtime secrets** from a parameter store keyed by env prefix (`/aegis/<env>/...`); no secrets in images/CI.
- **CI**: DRY GitLab CI with YAML anchors; `nx affected` gating; lint+test → build → promote → deploy.
- **Health**: `/health` (+ `?details=true`) probing DB + cache + bus; liveness/readiness; readiness gates traffic until deps are ready (improvement over the reference which listened early).
- **Observability**: OpenTelemetry to a collector; structured logs with correlation id; per-tenant + tamper-evident audit.

---

## 8. Implementation phases (tracked in IMPLEMENTATION_PLAN.md)

- **Phase 0 — Foundation**: monorepo scaffold, root config, `service-core` + `db` + `shared-*` skeletons, RLS helper, health, local docker-compose, CI skeleton.
- **Phase 1 — Access-control core**: `access-control` PDP (RBAC+ABAC), PEP guards, permission catalog; user-management identity (tenants/users/memberships/roles/permissions/policies/org-hierarchy) + IdP + PAP; audit; tenant RLS wired end-to-end.
- **Phase 2 — Service-to-service**: gateway (edge JWT validation, routing), internal-JWT + context propagation, event bus, token exchange.
- **Phase 3 — Domain services**: expense (port), invoice, workflow (rules engine), shared approval engine.
- **Phase 4 — Payroll & Notification**: payroll (with maker-checker, field encryption, ledger), notification (in-app + email, idempotent).
- **Phase 5 — Reporting**: CQRS-lite read models, RLS + column masking, report defs, scheduling/export.
- **Phase 6 — Hardening & deliverables**: tamper-evident audit, scalability (decision cache), security review, design doc + diagrams + API examples, deploy.

Each service is "done" only when it: shares `service-core` + `access-control`, enforces tenant RLS, has PEP guards on every route, emits audit, has unit tests, and a `docs/services/<svc>.md`.

---

## 9. Conventions

- **IDs**: UUID v4 PKs. Money: integer minor units. Timestamps: `created_at`/`updated_at` (`underscored: true`).
- **Errors**: typed errors via `ErrorUtils` → single Express error middleware → envelope `{ errors: [{ code, type, message, details, correlationId }] }`.
- **Responses**: explicit DTOs/serializers (no raw Sequelize rows). List endpoints: `{ data, meta: { total, page, pageSize } }`.
- **Permissions**: `domain.action[.sub]`, lower-case dotted. Resources referenced by enum.
- **Headers**: centralized in `HttpHeaderKey` enum. Table names in `TableName` enum.
- **Every route** is wrapped `authenticate → authorize(permission) → handler`. No unauthenticated route except `/health` and docs.
- **No external reference codebase, internal-package, or customer names anywhere.** No exercise/evaluation framing anywhere — Aegis is presented as a production enterprise platform.

---

## 10. Amendments — 2026-06-26

These refine §0–§9. Where they conflict, **these win**.

### 10.1 Scope removals
- **No GL codes** anywhere (expense or invoice). **No document-extracted line items** — we have no OCR/extraction pipeline, so line-item-level data and 3-way line matching are out of scope.
- **Invoice is header-level.** Status lifecycle + multi-level approval + a lightweight duplicate-entry guard. **No PO reference, no matching, no threshold/variance, no line items, no GL codes** (out of scope).
- **`entryContext` removed** from the request context (§6).
- **No exercise/evaluation framing** in any file. Scrub existing occurrences.

### 10.2 `@aegis/service-core` source of truth
The cross-cutting backbone is modeled on a **real, available reference**: an internal web reference's backend utils (`src/utils/context`, `.../utils/middleware`). Read it for the concrete RequestContext / context-manager / middleware / logger / http-client implementations and re-implement equivalents under `@aegis/service-core` (de-branded, AsyncLocalStorage-based). **Add explicit header validation** to the context middleware (required headers asserted, fail-closed).

### 10.3 ERP integration — pluggable connector framework (KEEP, productionize)
ERP/accounting sync **is** an enterprise requirement and increases trust (reconciliation with the customer's system of record). We **remove the ad-hoc "ERP sync"** and replace it with a proper **pluggable ERP connector framework** modeled on the ERP-integration reference (`app/services/erps/`): a common connector interface + adapter/strategy pattern + per-connector config, so a new ERP is added by writing one adapter.
- Implemented as a shared lib **`@aegis/connectors`** (interface + registry) consumed by expense/invoice/payroll.
- Ship **several MOCK connectors** with neutral names (e.g. `LedgerOne`, `Finovo`, `AcctBridge`) that emulate ERP behavior (auth handshake, push transaction, fetch status) **without calling real ERPs** — proving the infra is production-ready and any real ERP can be plugged in.
- ERP calls go through the service-to-service auth + context propagation + secret-proxy patterns; idempotency keys on every push. (Note: there is no `X-Trend` header; outbound connector auth is per-connector, carried via the connector's configured scheme.)

### 10.4 Local one-command run + dev environment (deliverable)
A single action brings the whole platform up **on a fresh machine with no manual env setup**:
- `scripts/dev-up.sh` (and a VS Code **build task** bound to **Cmd+Shift+B**, plus `.vscode/launch.json`) that: builds every app as a Docker image, starts dockerized **Postgres** (pre-seeded with the RLS non-owner app role + databases) and **Redis**, and runs every service container on one Docker network with correct ports/hostnames so they intercommunicate with **zero manual wiring**.
- **Per-service `.env` files committed with working dummy values** (`apps/<svc>/.env`) plus a root `.env` for infra; the dummy values are internally consistent so `docker compose up` works end-to-end out of the box. Real secrets override via env/param-store in real envs. (Reference: the internal web reference's `.env`/compose wiring.)
- "Ask Claude to run it" must also work: a documented single command.

### 10.5 Cloud IaC — Terraform (deliverable, showcase)
A **simple Terraform setup** under `infra/terraform/` (modeled on the IaC reference's `infra/terraform` module structure — env/{dev,prod} + modules/) that can stand the platform up on the cloud quickly: a relevant compute target (a VM / managed instance group **or** a container service), **Pub/Sub** (event bus), **autoscaling with min/max instances**, networking + NAT, and basic monitoring/alerts. Showcase-grade (not a full prod estate), demonstrating "instant cloud setup."

### 10.6 Testing, bug-hunting & flow recording (deliverables + autonomous)
- **`TESTING_PLAN.md`** + `docs/testing/` document, BEFORE building tests: every user flow / functionality to test, how to test it, expected results, and how to document/record runs. Structured **end-to-end flow catalogue** (one entry per flow across all services).
- **Flow recordings**: each flow is recorded (screen capture) and **annotated** so a viewer sees what is being done, what is expected, and whether it passed — organized, descriptive, shareable. Recording tooling chosen/wired later; the plan defines the flow list + annotation format now.
- **`BUGLOG.md`** — append-only log where scheduled testing/bug-hunting agents record issues (id, flow, severity, repro, expected vs actual, status) for later fixing.
- **Scheduled testing + bug-hunting agents** run periodically (overnight) once features land: exercise flows in conjunction, verify DB state/data integrity, verify cross-service flow correctness, and append findings to `BUGLOG.md`.

### 10.7 Frontend — ANALYSIS ONLY (no implementation yet)
Research (do **not** build yet) whether a **lightweight UI** is worth adding to showcase every flow — comprehensive enough to demonstrate capability, **without** replicating the heavy reference frontend. Deliverable: `docs/research/frontend-analysis.md` (options, effort, recommendation). Owner reviews before any build.

### 10.8 Autonomous build process
This platform is built across **multiple autonomous passes** driven by a self-paced loop + scheduled wake-up that **auto-resumes after usage-limit windows** (5-hourly) and overnight, with no human input. Each pass: read `AGENTS.md` + `IMPLEMENTATION_PLAN.md`, advance the next unchecked tasks, run/fix tests, update the plan + docs, commit. Spawning multiple sub-agents in one pass is fine (single top-level agent at a time).

### 10.9 New/updated phases
Folded into `IMPLEMENTATION_PLAN.md`: ERP connector framework (`@aegis/connectors` + mock connectors); local one-command Docker run + per-service `.env` + `.vscode` tasks; Terraform IaC; testing plan + flow catalogue + recording + bug-hunting agents; frontend analysis doc. (Reporting/payroll/etc. unchanged except for the scope removals above.)

---

## 11. Realignment v2 (2026-06-26) — closer reference fidelity

Supersedes earlier choices where they conflict. Driven by an architecture review: align tightly
with the established reference patterns, swap two technologies, and fix the eventing.

### 11.1 Structure — per-file, like the service-template reference
Every service mirrors the service-template reference's granularity:
- `models/<table>.model.ts` — ONE file per table (not a single `context.ts`); a `database-context.ts`
  imports + registers them.
- `repositories/<aggregate>.repository.ts` — ONE DAL per aggregate; tenant enforced via
  `@aegis/db` `withTenantTransaction` (+ RLS).
- `controllers/<resource>.controller.ts` — ONE controller per resource (not one big controller).
- `validators/<resource>.validator.ts` — Joi schemas live here; applied via a `validate(schema)`
  **middleware** (NOT inline in controllers).
- `index.ts` (thin) → `bootstrap.ts` (composition root: build server, ordered middleware chain,
  connect DB/cache/bus) — the service-template-reference pattern; plus a shared `createService(...)` helper in `service-core`.
- **Tests** live in a per-project `test/` folder (mirroring `src/`), NOT alongside source. Jest config
  per project points at `test/`.

### 11.2 All domain types/enums/constants live in `libs/shared/*`
Service-local DTOs/inputs/interfaces, `apps/*/src/constants`, and `*.types.ts` move into
`@aegis/shared-types` (`<domain>.shape.ts` namespaces), `@aegis/shared-enums`, and
`@aegis/shared-constants`. Services import them; they don't define domain types locally.

### 11.3 Access control → Casbin (per the domain reference), done correctly
Replace the in-house PDP with **Casbin** (`casbin` + `casbin-pg-adapter`): `model.conf` = RBAC with
domains (`sub, dom, act`); **`dom` = tenantId** (the tenant domain actually used, not the domain reference's `'*'`
hack). Policies persist in a `casbin` table, seeded from the role→permission catalog. The PEP keeps
**per-route guards** (`authenticate()` → `authorize(permission)`), where `authorize` calls
`enforcer.enforce(roleOrUser, tenantId, permission)`. Row-level scope stays a separate layer.

### 11.4 Eventing → Kafka (per the service-template reference), wired cross-service
Replace `RedisBus` with a **Kafka** transport (`kafkajs`) modeled on the service-template reference's `kafka-client`:
a producer + a back-pressure consumer (async queue, pause/resume) + a `CommitManager` for
at-least-once. Redis stays for **cache only**. Add Kafka (+ Zookeeper/KRaft) to `docker-compose.all.yml`.
Each service's `bootstrap` starts the producer; **consumer roles run via `PROCESS_TYPE=worker`**
(workflow + notification). Complete the topic→handler mappings so domain events
(`ExpenseApproved`/`InvoiceApproved`/`PayRunApproved`/…) actually trigger workflow rules and
notifications **across processes** (the current in-process bus does not).

### 11.5 Multi-tenancy parity with the domain reference
Add tenant-level config + feature flags (the domain reference's `company_config` / `company_feature` analogues):
`tenant_config` (per-tenant settings) + `tenant_features` (feature flags) tables + a config/feature
service in `user-management` + a `@aegis/service-core` helper to read flags; gate features by flag.
Keep Postgres RLS as the isolation mechanism (stronger than connection-per-tenant); ensure every
repository goes through `withTenantTransaction`.

### 11.6 ERP connectors → transformer + factory (per the ERP-integration reference)
Each connector gets a **transformer** (domain entity → ERP-specific payload) + the registry acts as
the **factory by ERP kind**, mirroring the ERP-integration reference's `*_bill_transformer` + orchestrator pattern.

### 11.7 Misc
- AuthZ: **per-route guards only** (no central AuthzConfig).
- Remove the root-level `.env` (services own their `.env`; compose hardcodes infra).
- Gateway: split `main.ts` into `routes-config` + `proxy` + `middleware`.
