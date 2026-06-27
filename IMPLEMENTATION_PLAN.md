# Aegis — Implementation Plan & Build Tracker

> The living build tracker. Every agent updates this file: tick tasks, refresh **Current status**
> and **Last updated**. Authoritative design lives in [`SPEC.md`](SPEC.md); this file is _progress_.

**Last updated:** 2026-06-27 (Wave 7 — secondary API + payroll/user-management closure pass) · **Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

> **Build mode:** autonomous multi-pass loop (self-paced + scheduled wake-up that auto-resumes
> after 5-hourly usage-limit windows and overnight). Each pass advances the next unchecked tasks,
> runs/fixes tests, updates this file + docs, commits. See [`SPEC.md`](SPEC.md) §10 for current scope.

---

## Current status

### Core platform built; completion audit API gaps closed

The platform has the core multi-tenant access-control demonstration in place, but the 2026-06-27
audit found real gaps in connector configuration, notification templates, and secondary
read/admin APIs. The audited API drift is now closed: notification/reporting secondary reads,
payroll own/all payslip reads, and user-management tenant/user/session/policy/invite APIs now have
backing models, route guards, validators, tests, and updated docs. This tracker should not be read as
"everything complete" until the open Phase 8/10 items below are closed and a full live-stack
verification passes.

What's built and verified (Nx build + `tsc` + Jest):

- **10 shared libs** — `service-core` (AsyncLocalStorage context + strict header validation, logger,
  error envelope, context-propagating HTTP client + internal s2s tokens, config/secrets, cache),
  `db` (non-owner Sequelize + RLS helpers + Umzug migrator), `access-control` (PDP RBAC+ABAC+scope,
  PEP authenticate/authorize), `events` (bus + Redis + outbox), `connectors` (3 mock ERPs), `audit`
  (hash-chained tamper-evident), `shared-enums/types/constants`, `testing`.
- **9 apps** — `gateway` (edge entry, correlation-id minting, routing) + 7 services (user-management
  = IdP + dynamic PAP + RLS; invoice; expense; workflow; payroll w/ field encryption + maker-checker;
  notification; reporting) + `cli` (migrations/seeders). Umzug migrations are wired through 0028
  (including teams/tags, connector configs, employee-user binding, sessions/invites/policies).
- **Operations** — single multi-purpose image + `PROCESS_TYPE`; one-command local run
  (`scripts/dev-up.sh` / Cmd+Shift+B / `docker-compose.all.yml` + per-service dummy `.env`); Terraform
  IaC (one `terraform apply`); hash-chained audit wired into login + role mgmt + every approve path.
- **Docs** — `SPEC.md`, `DESIGN.md`, 26-file `docs/` suite + interactive HTML + `TESTING_PLAN.md` +
  flow catalogue; all forbidden-name clean.

### Remaining (Docker-gated or owner-decision — see notes)

- **Live verification on a Docker machine**: `bash scripts/dev-up.sh` (brings up Postgres+Redis+all
  services), then run the integration flows in `docs/testing/flow-catalogue.md` — cross-tenant RLS
  isolation, login→JWT→PEP, dynamic role assignment, expense/invoice/payroll approve→ERP push,
  notification idempotency, audit `verifyChain`. (Docker is not on this build machine's PATH.)
- **Scheduled bug-hunting agents** (Phase 10): wire to run the flow catalogue against the live stack
  and append to `BUGLOG.md` — meaningful only against a running app.
- **Frontend** (Phase 11): **analysis-only**, see `docs/research/frontend-analysis.md` — awaiting your
  decision before any build.
- **Production hardening** (Phase 6): RS256/JWKS IdP + refresh tokens + per-request session
  introspection + 2FA, PDP decision cache, reporting BullMQ export workers, full security review —
  documented upgrade seams.

**To resume polish:** say "continue the Aegis build" (the loop reads this file). **To run it:**
`npm ci && bash scripts/dev-up.sh`.

---

> **Wave 7 — ERP/notification/API audit pass**: notification now has a per-template TS catalog
> (`apps/notification/src/templates/*.template.ts`) with text + HTML bodies and the renderer forwards HTML to Nodemailer; user-management exposes the internal contact/audience directory that notification fan-out calls; ERP sync now has
> `connector_configs` migration/model/repository, demo seed data, workflow admin APIs
> (`/workflow/v1/connectors*`), a DB-backed connector config store, connector auth hook invocation,
> a tenant-scoped operator reconcile endpoint (`POST /workflow/v1/connectors/reconcile`),
> and expense approval stages `ConnectorPushRequested` in the outbox instead of calling the connector
> inline. Added focused detail APIs for expense items, pay-runs, notifications, and an `authorize`
> guard on `/auth/me`. Follow-up closed notification unread/read-all/email-log APIs, reporting
> run-list/export/schedule APIs, non-sensitive payroll payslip list/detail APIs, then closed the
> ownership gap by binding `employees.user_id` and routing `payroll.payslip.view.own` through that
> bridge. User-management now has tenant/user read APIs plus session issuance/list/revoke, ABAC policy
> CRUD, and invite issue/list/revoke backed by migration 0028. Focused Jest suites pass and touched
> app/lib type-checks are green. Remaining connector hardening: automated cross-tenant reconcile
> scheduling, secret resolution/token refresh, and terminal sync callbacks back into owning records.

> **Wave 6 — COMPLETE behind `record.annotations`**: teams/team_members + team FK, tenant tag catalog,
> team_tags, polymorphic record_tags, assignee_id, user-management governance CRUD, record-tag and
> assignee write paths, finance list filters, workflow tag/team/assignee conditions, RBAC permissions,
> and focused unit tests are implemented. Type-checks are green for the affected libs/apps. Full Jest
> was run, but this sandbox blocks `app.listen(0)` (`listen EPERM`) in existing service-core HTTP
> middleware/bootstrap tests; the Wave 6 focused suites passed.

> **Wave 3 (approval engine) — COMPLETE**: @aegis/approvals (policies/thresholds/manager-hierarchy/groups/supersede/parallel-sequential) wired into expense+invoice+payroll (request→decide→ApprovalCompleted→advance), payroll SoD double-guarded; dev email provider (nodemailer, no SES). 437 tests.

> **Wave 4 — COMPLETE**: README enterprise showcase, docs/deployment-topology.md, one-command scripts/setup.sh + Postman + curl, interactive docs/flows.html dashboard, libs/audit jest config honesty fix.

## Phase R — Reference-fidelity realignment (v2, 2026-06-26) — IN PROGRESS

> Architecture-review follow-up. See [`SPEC.md`](SPEC.md) §11. Do shared/infra changes first, then
> refactor `user-management` as the reference template, then roll across all services. Keep everything
> building + tests green at each step.

**Shared / infra (do first):**

- [x] `@aegis/events` → **Kafka** transport (kafkajs Producer + back-pressure Consumer + `CommitManager` at-least-once), modeled on the service-template reference's `kafka-client`. Remove `RedisBus`. Add Kafka to `docker-compose.all.yml`. Consumers run via `PROCESS_TYPE=worker`.
- [x] `@aegis/access-control` → **Casbin** (`casbin` + `casbin-pg-adapter`), `model.conf` RBAC-with-domains (**`dom` = tenantId**); `casbin` table migration; seed role→permission policies; `authorize()` calls `enforce(role, tenant, permission)`; keep per-route guards. Keep row-level scope as a separate layer.
- [x] `@aegis/service-core` → shared `createService()`/bootstrap helper; services use thin `index.ts` → `bootstrap.ts` (composition root, ordered init) per the service-template reference.
- [x] Tenant config + **feature flags**: `tenant_config` + `tenant_features` tables (the domain reference's `company_config`/`company_feature` analogues) + service in user-management + `service-core` flag helper; gate features.
- [x] `@aegis/connectors` → per-connector **transformer** (domain→ERP payload) + factory-by-kind (ERP-integration-reference pattern).

**Per-service refactor (user-management first as template, then all 8 + cli):**

- [x] Split `models/context.ts` → `models/<table>.model.ts` + `database-context.ts` (one file per table).
- [x] Split repository → `repositories/<aggregate>.repository.ts` (one per aggregate); all via `withTenantTransaction`.
- [x] Split controllers → `controllers/<resource>.controller.ts` (one per resource).
- [x] `validators/<resource>.validator.ts` + `validate(schema)` **middleware** (remove inline validation from controllers).
- [x] Thin `index.ts` + `bootstrap.ts`.
- [x] Move domain DTOs/types/enums/constants → `@aegis/shared-types` / `-enums` / `-constants` (nothing domain-typed local).
- [x] Move tests → per-project `test/` folder (mirror `src/`); per-project jest config.
- [x] Enrich table schemas toward reference-grade comprehensiveness — CHECK constraints (status/enum domains + non-negative money) across all 7 domain migrations, created_by/updated_by audit cols on mutable entities, soft-delete (deleted_at + paranoid) on 14 master/aggregate models, composite (tenant_id,status)/(tenant_id,created_at) + FK + idempotency indexes. Additive only; append-only log/ledger/activity tables left immutable.

**Gateway + verify:**

- [x] Split gateway `main.ts` → `routes-config` + `proxy` + `middleware`.
- [x] `nx run-many -t build lint test` green (9 apps build · 154 tests · lint 0 errors · forbidden clean). _Cross-service Kafka flow (expense approve → workflow rule → notification) is wired (worker containers in compose); live E2E is Docker-gated._

## Phase 0 — Foundation & scaffolding

- [x] Monorepo structure (`apps/*`, `libs/*`), Nx config, `tsconfig.base.json` path aliases
- [x] Root tooling: package.json, eslint, prettier, editorconfig, .gitignore
- [x] Single multi-purpose `Dockerfile` + `scripts/start.sh` (`PROCESS_TYPE` api/worker/migration)
- [x] `docker-compose.yml` (Postgres as non-owner app role for RLS, Redis)
- [x] DRY `.gitlab-ci.yml` (verify → build SHA image → promote/deploy)
- [x] `SPEC.md`, `AGENTS.md`, `README.md`, `IMPLEMENTATION_PLAN.md`
- [x] `docs/` suite + interactive HTML
- [x] `@aegis/service-core`: RequestContext (AsyncLocalStorage), Logger (pino), ErrorUtils + error envelope, context-propagating HttpClient, Config/Secrets, CacheAdapter (Redis), middleware (context w/ strict header validation, request-log, error), bootstrap helper — **type-checks clean** (audit middleware lands with the audit phase)
- [x] `@aegis/db`: non-owner Sequelize connection, RLS helpers (`set_config(...,true)` per-txn tenant context + FORCE/RESTRICTIVE policy SQL generator), tenant-scoped transaction helper, Umzug migration + seeder runners, base model helpers — type-checks clean. _DatabaseContext model registry is per-service._
- [x] `@aegis/shared-enums`: barrel + `HttpHeaderKey` + `TableName` + `Permission` (dotted catalog) + `SystemRole` + `Scope` + per-domain enums (type-checks clean)
- [x] `@aegis/shared-types`: `common.shape.ts` (paging, error envelope, TenantScoped) + `access.shape.ts` (PDP Principal/Resource/Decision/PolicyRule) — type-checks clean
- [x] `@aegis/shared-constants`: Api/Pagination/Auth/Health/Rls Constants classes — type-checks clean
- [x] `@aegis/events`: `EventTopic` enum + context-carrying envelopes, in-process bus (default) + Redis pub/sub transport, transactional-outbox helper (`withOutbox`); handlers run inside a rebuilt RequestContext — type-checks clean
- [x] `@aegis/testing`: context stub, PDP stub, fixture helpers — runInContext + makePrincipal/makeResource fixtures
- [x] `apps/cli`: Umzug `migrate` / `migrate-seeders` / `show-migrations` / `reverse-last` (explicit migration list, bundled-app safe) — builds clean. _(live run gated on Docker, which isn't on this env's PATH; runs via dev-up.sh)_
- [x] Health endpoint pattern (`/health` + `?details=true` pinging DB + cache) — established in user-management; `excludePaths` added to context middleware so health bypasses header validation. _(traffic-gating readiness probe wired at deploy.)_
- [x] **App build/runtime proven**: `apps/user-management` Nx webpack build succeeds (bundles `@aegis/*` sources, externalizes node_modules) → `dist/apps/user-management/main.js`. Lib `build` targets removed (apps bundle lib sources). This unblocks all 8 apps.
- [ ] One end-to-end "hello, tenant" slice: a trivial controller behind `authenticate → authorize` proving context + RLS works

## Phase 1 — Access-control core + identity (the heart)

- [x] `@aegis/access-control` PDP: `decide(principal, action, resource, policies)` — RBAC check + tenant isolation + row-level scope (AllRecords/OwnAndTeam/OwnOnly) + ABAC condition evaluator (deny-overrides, allow-policy match); fail-closed. **6 unit tests pass.** _(decision cache + short TTL deferred to the scalability phase)_
- [x] Permission catalog (dotted `domain.action` `permissions` table) + explicit `role_permissions` join — created by migration 0001, seeded with the full `Permission` catalog. _(runtime repository/model lands with user-management.)_
- [x] PEP: `authenticate()` (JWT verify + token-tenant match) + `authorize(permission, { resource?, policies? })` Express guards; obligations placed on `res.locals.obligations`; fail-closed. _Repo-wide Jest harness set up (path-alias aware)._
- [~] `user-management` models: tenants, users, permissions, roles (system+custom), role*permissions, user_roles (scope), tenant config/features, teams/tags/record_tags, invites, sessions, and policies defined (Sequelize) + repositories (RLS-scoped). *(Org-unit and manager-hierarchy admin APIs remain hardening.)*
- [~] Reference IdP: register / login (issues a **permission-bearing JWT**: sub, tenant*id, roles, permissions, scope, aud, jti) over RLS-scoped data + PEP-guarded `/me`; login writes a `sessions` row; scrypt password hashing. *(HS256 for local; RS256/ES256 + JWKS + refresh tokens + per-request session introspection + 2FA are documented upgrade seams.)\_
- [x] PAP: PEP-guarded runtime endpoints — list roles/permissions, **create custom role + permission set** (no migration/deploy), **assign role + scope** to a user, and ABAC policy CRUD. Demo-tenant seeder (`0002_demo_tenant`) provisions a tenant + Admin user for immediate local testing.
- [~] Tenant RLS schema: migration 0001 enables FORCE + RESTRICTIVE policies on tenants (id), users (tenant*id), roles (tenant_id-or-null), user_roles (tenant_id). \_Cross-tenant isolation integration test pending a live Postgres (Docker).*
- [x] Audit: generic activity feed + `audit_log` (actor, tenant, action, decision, permissions-at-time), hash-chained — **@aegis/audit**: append-only hash-chained audit*log (actor/tenant/action/outcome/resource/details + permissions-at-time, sha256 prev_hash chain), AuditLogger.record + verifyChain, migration 0008 + RLS. **3 tamper-evidence tests pass.** *(wiring record() into each service write-path is incremental.)\_
- [x] Seed: 11 system roles (Owner/Admin/Manager/Approver/Contributor/Viewer/PayrollAdmin/PayrollApprover/FinanceDisburser/Auditor/Employee) + full permission catalog + role→permission mappings (`0001_system_roles` seeder, not hardcoded in app)
- [~] Unit tests: PDP allow/deny matrix (6) + ABAC condition evaluator (6) + internal-token verify (3) + connectors (4) + audit hash-chain (3) + password (4) = **26 tests pass**. _Tenant-isolation + dynamic-role-CRUD integration tests need a live Postgres (Docker)._

## Phase 2 — Service-to-service & edge

- [x] `apps/gateway`: edge JWT validation (JWKS, `aud` check), routing, rate limiting, request-id minting — **built**: single entry, correlation-id minting at edge, routing/proxy to all 7 services, context-header propagation; services enforce auth (defense-in-depth)
- [x] Internal-auth: signed internal JWT (issuer/audience/exp), `X-Internal-Origin` gate, `X-Source-Service` propagation; `service-core` middleware to verify — **built** in @aegis/service-core: signInternalToken (iss/aud/exp), internalAuth() middleware (X-Internal-Origin gate + verify + sets sourceService)
- [x] Context propagation across hops (`X-Tenant-Id`, `X-Correlation-Id`, `X-Trace-Id`, `X-Caller`) via HttpClient + event headers — **built**: HttpClient injects X-Tenant-Id/X-Correlation-Id/X-Caller/X-Source-Service/X-Internal-Token; gateway forwards; event envelopes carry tenant+correlation
- [ ] Token exchange (RFC 8693) downscope/re-audience for internal calls; delegation (`sub`+`act`)
- [ ] Event bus live (Redis transport locally) with transactional outbox; cross-service event contract documented

## Phase 3 — Core domain services

- [ ] Shared **approval engine** lib/module: approval_policies → hierarchy(level) → approver_groups → members (user/role/team/persona) → thresholds; next-approver resolver; approval_progress_log
- [x] `invoice` (HEADER-LEVEL): invoices (status state machine), invoice_metadata, invoice_duplicates, approval binding, activities; "matching" = duplicate detection + threshold/variance vs optional PO ref + approval routing (NO line items / match groups / GL codes); PEP on every route; emits events — **built + bundles** (duplicate detection, LedgerOne push)
- [x] `expense` (ported from Python reference): expense_reports (state machine), expenses, categories, approvals, comments, activities (NO GL codes / line items); ERP push requested via outbox + `@aegis/connectors` worker; PEP guards; events
- [x] `workflow`: rules-as-data (rules, rule_steps jsonb query, rule_actions), field-validator registry + action-handler registry, rule_audit_log; triggered via event bus
- [ ] Cross-service flow demo: invoice/expense event → workflow rule → approval routing → notification

## Phase 4 — Payroll & Notification

- [x] `payroll`: employees (field-encrypted salary/bank/national-id), employment_contracts, pay_calendars, earning/deduction codes, tax_rules (jurisdiction, effective-dated), employee_pay_items, pay_runs (Draft→Calculated→Approved→Paid), payslips, payslip_lines, payroll_input_items (idempotency), payments, payment_batches, ledger_entries (append-only) — **built** (aes-256-gcm field encryption, maker-checker approve, append-only ledger, GL push)
- [ ] Payroll access control: granular field-level RBAC + masking; **maker-checker** (approver ≠ editor) enforced in code; sensitive-field-read audit
- [ ] Payroll inbound: consume approved expense reimbursements/bonuses as earning lines (idempotent)
- [x] `notification`: notifications (in-app), email_notification_logs (status), text+HTML template catalog, idempotent send (lock-row), event-driven; never re-derives authority

## Phase 5 — Reporting (CQRS-lite)

- [ ] Read models: fact_expense / fact_invoice / fact_payroll / fact_approval + dimensions, fed from source events (outbox) or read-replica + materialized views
- [ ] RLS on all reporting tables; row + column-level access; column masking via report-definition compiler
- [x] `report_definitions` (declarative spec), `report_schedules`, `report_runs` (async, 202 + runId), export (CSV/XLSX/PDF) via BullMQ workers → object storage + signed URL — **built** (async 202+runId runs, column-masking policies)
- [ ] Result cache keyed by `{tenant, access-scope, definition, params}` (access-scope in key — no cross-user leak); freshness/as-of timestamp

## Phase 6 — Hardening & deliverables

- [ ] Tamper-evident audit verification tooling; per-tenant retention config
- [ ] Scalability: PDP decision cache tuning, load-test the hot authz path, document targets
- [ ] Security review (token handling, RLS bypass attempts, SoD, secret handling); fix findings
- [x] **Design document** (PDF/Markdown): functional + non-functional reqs, architecture, authn/authz flow, multi-tenant isolation, access-control model, s2s security, APIs + data models, scalability/reliability, security/compliance, operations — with diagrams (architecture, sequence, schema) and API examples — **DESIGN.md** consolidates all required deliverables + links docs/; diagrams (Mermaid) + interactive HTML + per-service docs already present
- [ ] Final pass: grep for forbidden names; ensure README/docs/HTML current; verify `nx run-many -t lint test build` green

---

## Cross-cutting "always-on" checklist (applies to every service as it's built)

- [ ] Shares `@aegis/service-core` (context, logger, errors) and `@aegis/access-control` (PEP)
- [ ] `tenant_id` + RLS on every table; non-owner DB role; `SET LOCAL` per txn
- [ ] `authenticate → authorize(permission)` on every route; fail-closed
- [ ] Audit entry on every state-changing action
- [ ] Joi validation; explicit DTO responses; typed errors → envelope
- [ ] Unit tests above coverage gate; `docs/services/<svc>.md` updated
- [ ] No forbidden names

---

## Phase 7 — ERP connector framework (`@aegis/connectors`)

- [x] `@aegis/connectors`: `Connector` interface (authenticate/pushTransaction/getStatus/healthCheck), `BaseConnector` (idempotency + retry/backoff + auth hook + audit), `ConnectorRegistry` (strategy by kind), per-connector config — type-checks clean
- [x] Mock connectors `LedgerOne` (sync), `Finovo` (queued→synced), `AcctBridge` (validates payload) emulate ERP behaviour WITHOUT real calls; auto-registered. **4 tests pass** (registry, idempotency, validation)
- [x] Wire expense/invoice/payroll "post approved transaction to ERP" as `ConnectorPushRequested` outbox events consumed by workflow's ERP-sync worker; no finance request path calls a connector inline.
- [x] Per-tenant connector config: `connector_configs` migration/model/repository, demo seed data, DB-backed `ConnectorConfigStore`, workflow admin APIs for config, health, and sync-state.
- [~] Scheduled reconcile driver + terminal callbacks: `reconcilePending()` exists and is exposed through tenant-scoped `POST /workflow/v1/connectors/reconcile`, but no automated scheduler yet enumerates tenants/configs or updates owning records when async ERP status becomes terminal.
- [~] Secret/token hardening: config stores `credentials_ref` and connectors call `authenticate(config)`, but secret proxy resolution and token-refresh-on-auth-failure remain upgrade seams.
- [x] `docs/services/connectors.md` — current implementation notes + remaining hardening items.

## Phase 8 — Local one-command run & developer experience

- [ ] `scripts/dev-up.sh` — one command: build every app Docker image, start dockerized Postgres (pre-seeded RLS non-owner role + DBs) + Redis, run all service containers on one Docker network, wired with correct ports/hostnames; zero manual env
- [ ] `scripts/db-init/*.sql` — create app (non-owner, no BYPASSRLS) role + per-service DBs/schemas
- [ ] `docker-compose.all.yml` — all services + infra, internal DNS hostnames, healthchecks, depends_on
- [ ] Per-service `apps/<svc>/.env` committed with consistent working DUMMY values (+ root `.env`); `docker compose up` works end-to-end with no manual setup
- [ ] `.vscode/tasks.json` (build/up bound to Cmd+Shift+B) + `.vscode/launch.json` + `.vscode/settings.json`
- [ ] `docs/09-deployment-and-ops.md` "Run it locally in one step" section (script + Cmd+Shift+B + "ask Claude to run")

## Phase 9 — Cloud IaC (Terraform showcase)

- [x] `infra/terraform/` modeled on the IaC reference (env/{dev,prod} + modules/): compute (VM/MIG or container service) + Pub/Sub (event bus) + autoscaling (min/max) + network/NAT + monitoring/alerts + workload identity — **built**: env/dev + modules (network+NAT, Cloud SQL Postgres, Pub/Sub event bus, Cloud Run per-service autoscaling min/max, monitoring); one `terraform apply`
- [x] `infra/terraform/README.md` — "stand the platform up on the cloud in one `terraform apply`" — written

## Phase 10 — Testing, recording & bug-hunting

- [x] `TESTING_PLAN.md` + `docs/testing/flow-catalogue.md` — every flow/functionality to test, how, expected result, how to document/record (authored BEFORE building tests)
- [x] `BUGLOG.md` — append-only issue log (id, flow, severity, repro, expected vs actual, status)
- [~] Integration/E2E test harness exercising flows in conjunction + DB-state/data-integrity verification
- [x] Flow recording: per-flow annotated screen capture (what/expected/pass-fail), organized + shareable; tooling wired (deferred), format defined now
- [ ] Scheduled testing + bug-hunting agents (periodic/overnight) that run the flow catalogue, verify DB + cross-service correctness, append to `BUGLOG.md`

## Phase 11 — Frontend (ANALYSIS ONLY — no build yet)

- [x] `docs/research/frontend-analysis.md` — lightweight-UI options/effort/recommendation written. **Owner reviews before any build (do not build yet).**

---

## Decision log (append-only — record any change to SPEC decisions here)

- 2026-06-25 — Initial decisions locked: Nx monorepo · all 7 services · Expense ported to Node/TS ·
  PostgreSQL + RLS · in-house RBAC+ABAC (not Casbin) · service-core replaces the architecture reference's service-util ·
  domain-reference deployment model adopted. (See SPEC.md §1.)
- 2026-06-26 — Amendments (SPEC.md §10): remove GL codes + document-extracted line items; invoice is
  header-level (matching = duplicate + threshold + approval); remove `entryContext`; add strict header
  validation; `@aegis/service-core` modeled on an internal web reference; **keep ERP** as pluggable
  `@aegis/connectors` framework + mock connectors (not ad-hoc sync); local one-command Docker run +
  per-service dummy `.env` + `.vscode` Cmd+Shift+B; Terraform IaC showcase; testing plan + flow
  catalogue + recording + scheduled bug-hunting agents; frontend = analysis-only; scrub all
  exercise/evaluation framing wording; build runs as an autonomous multi-pass loop.
