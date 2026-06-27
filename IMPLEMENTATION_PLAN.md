# Aegis — Implementation Plan & Build Tracker

> The living build tracker. Every agent updates this file: tick tasks, refresh **Current status**
> and **Last updated**. Authoritative design lives in [`SPEC.md`](SPEC.md); this file is _progress_.

**Last updated:** 2026-06-27 (live local-stack hardening — current-code services running in iTerm against Dockerized Postgres/Redis/Kafka; scripted HTTP flows + live E2E green; per-service image packaging added) · **Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

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
  notification; reporting) + `cli` (migrations/seeders). Umzug migrations are wired through 0031
  (including teams/tags, connector configs, employee-user binding, sessions/invites/policies,
  permissive RLS base, RLS-safe outbox tenant cast, audit hash canonicalization).
- **Operations** — per-service Docker images + `PROCESS_TYPE`; one-command local run
  (`scripts/dev-up.sh` / `scripts/setup.sh` / `scripts/test-dockerized.sh` + per-service dummy `.env`); fast local
  loop (`scripts/dev-local-iterm.sh`) runs current TypeScript services in one iTerm window against Dockerized infra; Terraform
  IaC (one `terraform apply`); hash-chained audit wired into login + role mgmt + every approve path.
- **Docs** — `SPEC.md`, `DESIGN.md`, the `docs/` suite (indexed by `docs/README.md`: `ARCHITECTURE.md`
  + `architecture/` chapters + per-service + numbered `0N-*.md` deep-dives + `api/` + `testing/`) +
  interactive HTML + `TESTING_PLAN.md` + flow catalogue + the append-only `BUGLOG.md` (all 16 logged
  bugs fixed); all forbidden-name clean. _(The old `docs/research/` + `docs/analysis/` dirs were
  removed; their decision content is folded into `SPEC.md` §10/§11 and the architecture chapters.)_

### Remaining (Docker-gated or owner-decision — see notes)

- **Final Dockerized acceptance pass**: after the remaining live-flow expansion, run
  `bash scripts/test-dockerized.sh` from a clean state. It builds the per-service images, opens one
  iTerm log window when available, and runs the predefined HTTP flow script in a disposable Node
  container on the Compose network. Current fast-loop verification is green against local
  current-code services: scripted HTTP flows, `apps/e2e-tests/live`, DB metadata, and audit chain.
- **Live Swagger / `/api-docs` serving**: the offline reference (`docs/api/index.html` rendered from
  `docs/api/openapi.yaml`) is complete and each service reserves a context-bypassing `/api-docs` path,
  but no service yet mounts a Swagger UI from the spec at runtime. Wiring the live UI is the remaining
  API-docs item.
- **Scheduled bug-hunting agents** (Phase 10): wire to run the flow catalogue against the live stack
  and append to `BUGLOG.md` — meaningful only against a running app.
- **Frontend** (Phase 11): **analysis-only** (the standalone `docs/research/frontend-analysis.md`
  artifact was removed with the rest of `docs/research/`; the decision — do not build yet — is
  recorded in `SPEC.md` §11). Awaiting your decision before any build.
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
- [x] `nx run-many -t build lint test` green (9 apps build · ~198 spec files / ~693 unit cases · lint 0 errors · forbidden clean). _Cross-service Kafka flow (expense approve → workflow rule → notification) is wired (worker containers in compose); live E2E is Docker-gated._

## Phase 0 — Foundation & scaffolding

- [x] Monorepo structure (`apps/*`, `libs/*`), Nx config, `tsconfig.base.json` path aliases
- [x] Root tooling: package.json, eslint, prettier, editorconfig, .gitignore
- [x] Per-service `Dockerfile.service` + `scripts/start.sh` (`PROCESS_TYPE` api/worker/migration)
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
- [x] One end-to-end "hello, tenant" slice: superseded — the real `authenticate → authorize` + RLS path is proven by the user-management IdP/PAP routes and every per-service PEP-guarded controller (each runs context validation + the RLS `SET LOCAL app.current_tenant` path); no separate trivial slice needed. _(The cross-tenant isolation assertion itself is the Docker-gated live test.)_

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
- [ ] Token exchange (RFC 8693) downscope/re-audience for internal calls; delegation (`sub`+`act`) — **not yet built** (still a documented upgrade seam; internal calls currently use the signed `service-core` internal JWT + `X-Internal-Origin` gate)
- [x] Event bus live with transactional outbox: `@aegis/events` runs on **Kafka** (kafkajs producer + back-pressure consumer + `CommitManager` at-least-once) with the `withOutbox` transactional-outbox helper + `OutboxRelay` (BUG-0003 adaptive-drain fix), `event_outbox` migration (0011, RLS-safe tenant cast in 0030); consumers run via `PROCESS_TYPE=worker` in `docker-compose.all.yml`. Cross-service event contract is documented in `docs/architecture/01-system-overview.md` + `02-rules-and-workflow.md`. _(Live cross-service propagation is Docker-gated.)_

## Phase 3 — Core domain services

- [x] Shared **approval engine** lib/module (`@aegis/approvals`, Wave 3 — COMPLETE): approval_policies → hierarchy(level) → approver_groups → members (user/role/team/persona) → thresholds; next-approver resolver (`resolver.ts`); approval progress log; parallel/sequential + quorum + supersede (migrations 0012/0013). Wired into expense + invoice + payroll. _(BUG-0004/0005/0006/0007 hardening fixes applied.)_
- [x] `invoice` (HEADER-LEVEL): invoices (status state machine), invoice_metadata, invoice_duplicates, approval binding, activities; "matching" = duplicate detection + threshold/variance vs optional PO ref + approval routing (NO line items / match groups / GL codes); PEP on every route; emits events — **built + bundles** (duplicate detection, LedgerOne push)
- [x] `expense` (ported from Python reference): expense_reports (state machine), expenses, categories, approvals, comments, activities (NO GL codes / line items); ERP push requested via outbox + `@aegis/connectors` worker; PEP guards; events
- [x] `workflow`: rules-as-data (rules, rule_steps jsonb query, rule_actions), field-validator registry + action-handler registry, rule_audit_log; triggered via event bus
- [x] Cross-service flow demo wired: invoice/expense event → workflow rule → approval routing → notification is implemented end-to-end over Kafka (workflow consumes domain events and runs rules; `approval.command` + `notification.requested` rule-action consumers exist — BUG-0001/BUG-0002 fixes). _(Executing the full chain against a running stack is the Docker-gated live E2E.)_

## Phase 4 — Payroll & Notification

- [x] `payroll`: employees (field-encrypted salary/bank/national-id), employment_contracts, pay_calendars, earning/deduction codes, tax_rules (jurisdiction, effective-dated), employee_pay_items, pay_runs (Draft→Calculated→Approved→Paid), payslips, payslip_lines, payroll_input_items (idempotency), payments, payment_batches, ledger_entries (append-only) — **built** (aes-256-gcm field encryption, maker-checker approve, append-only ledger, GL push)
- [x] Payroll access control: granular field-level RBAC + masking (`employee.service.ts` decrypt-then-`maskLast4`; clear PII gated on the `payroll.sensitive.read` obligation, default-deny ⇒ masked) + **maker-checker** SoD enforced in code (`pay-run.service.ts assertSegregationOfDuties` — approver ≠ creator/editor, a hard domain invariant double-guarded alongside the approval policy's `excludeRequester`) + sensitive-field-read audit (clear reads recorded, masked reads not).
- [x] Payroll inbound: consume approved expense reimbursements/bonuses as earning lines (idempotent) — `apps/payroll/src/consumers/approval-completed.consumer.ts` + `record-update.consumer.ts` feed pay-run inputs through the idempotent `payroll_input_items` path.
- [x] `notification`: notifications (in-app), email_notification_logs (status), text+HTML template catalog, idempotent send (lock-row), event-driven; never re-derives authority

## Phase 5 — Reporting (CQRS-lite)

> The declarative report **engine** (definitions/schedules/runs/export + column-masking) is built and
> migrated (0007). The dedicated denormalized `fact_*` read-model layer and the access-scope result
> cache below are **not yet built** — they remain the CQRS-lite scalability upgrade for this service.

- [ ] Read models: fact_expense / fact_invoice / fact_payroll / fact_approval + dimensions, fed from source events (outbox) or read-replica + materialized views — **not yet built** (reporting currently reads via report definitions over source data; the dedicated fact tables are a future scalability layer)
- [~] RLS on all reporting tables; row + column-level access; column masking via report-definition compiler — column-masking policies in report definitions are built; RLS + row-level access apply to the existing `report_*` tables, but the (not-yet-built) `fact_*` read models still need their own RLS
- [x] `report_definitions` (declarative spec), `report_schedules`, `report_runs` (async, 202 + runId), export (CSV/XLSX/PDF) via BullMQ workers → object storage + signed URL — **built** (async 202+runId runs, column-masking policies; migration 0007)
- [ ] Result cache keyed by `{tenant, access-scope, definition, params}` (access-scope in key — no cross-user leak); freshness/as-of timestamp — **not yet built** (no access-scope-keyed result cache yet; documented upgrade seam)

## Phase 6 — Hardening & deliverables

- [ ] Tamper-evident audit verification tooling; per-tenant retention config
- [ ] Scalability: PDP decision cache tuning, load-test the hot authz path, document targets
- [ ] Security review (token handling, RLS bypass attempts, SoD, secret handling); fix findings
- [x] **Design document** (PDF/Markdown): functional + non-functional reqs, architecture, authn/authz flow, multi-tenant isolation, access-control model, s2s security, APIs + data models, scalability/reliability, security/compliance, operations — with diagrams (architecture, sequence, schema) and API examples — **DESIGN.md** consolidates all required deliverables + links docs/; diagrams (Mermaid) + interactive HTML + per-service docs already present
- [ ] Final pass: grep for forbidden names; ensure README/docs/HTML current; verify `nx run-many -t lint test build` green

---

## Cross-cutting "always-on" checklist (applies to every service as it's built)

- [x] Shares `@aegis/service-core` (context, logger, errors) and `@aegis/access-control` (PEP) — every app bootstraps via `service-core` `createService()` and guards routes via the PEP
- [x] `tenant_id` + RLS on every table; non-owner DB role; `SET LOCAL` per txn — enforced via `@aegis/db withTenantTransaction` + FORCE/RESTRICTIVE policies (migrations through 0031; 0029 permissive base, 0030 RLS-safe outbox cast). _(Live cross-tenant isolation assertion is Docker-gated.)_
- [x] `authenticate → authorize(permission)` on every route; fail-closed (incl. `/auth/me` — BUG-0012 fix)
- [x] Audit entry on every state-changing action — `@aegis/audit` hash-chained log wired into login, role mgmt, and every approve/disburse path
- [x] Joi validation (per-resource validator + `validate(schema)` middleware); explicit DTO responses; typed errors → envelope
- [x] Unit tests (198 spec files / ~693 cases across apps + libs); `docs/services/<svc>.md` present and current for all 7 services + connectors
- [x] No forbidden names — final-pass grep clean

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

- [x] `scripts/dev-up.sh` / `scripts/setup.sh` — one command: build every per-service image, start dockerized Postgres (pre-seeded RLS non-owner role + DBs) + Kafka + Redis, run all service containers on one Docker network, wired with correct ports/hostnames; zero manual env.
- [x] `scripts/db-init/*.sql` — `01-init.sql` creates the app (non-owner, no BYPASSRLS) role + per-service DBs/schemas
- [x] `docker-compose.all.yml` — all services + infra, internal DNS hostnames, healthchecks, depends_on, `PROCESS_TYPE=worker` consumers
- [x] `scripts/dev-local-iterm.sh` — fast hardening loop: Dockerized infra only; current TypeScript services/workers run in one split-pane iTerm window; no image rebuild required.
- [x] `scripts/test-dockerized.sh` + `scripts/e2e/http-flow-tests.js` — reviewer path: setup full Docker stack, open live logs, run predefined HTTP flow assertions from a disposable Node container.
- [x] Per-service `apps/<svc>/.env` committed with consistent working DUMMY values (all 8 services + cli + gateway); `docker compose up` works end-to-end with no manual setup
- [~] `.vscode/tasks.json` (build/up bound to Cmd+Shift+B) + `.vscode/settings.json` present; **`.vscode/launch.json` is referenced in `docs/09-deployment-and-ops.md` but not yet committed** — add it or drop the doc reference
- [x] `docs/09-deployment-and-ops.md` "Run it locally in one step" section (script + Cmd+Shift+B + "ask Claude to run") — written (§1)

## Phase 9 — Cloud IaC (Terraform showcase)

- [x] `infra/terraform/` modeled on the IaC reference (env/{dev,prod} + modules/): compute (VM/MIG or container service) + Pub/Sub (event bus) + autoscaling (min/max) + network/NAT + monitoring/alerts + workload identity — **built**: env/dev + modules (network+NAT, Cloud SQL Postgres, Pub/Sub event bus, Cloud Run per-service autoscaling min/max, monitoring); one `terraform apply`
- [x] `infra/terraform/README.md` — "stand the platform up on the cloud in one `terraform apply`" — written

## Phase 10 — Testing, recording & bug-hunting

- [x] `TESTING_PLAN.md` + `docs/testing/flow-catalogue.md` — every flow/functionality to test, how, expected result, how to document/record (authored BEFORE building tests)
- [x] `BUGLOG.md` — append-only issue log (id, flow, severity, repro, expected vs actual, status)
- [x] Integration/E2E test harness exercising flows in conjunction + DB-state/data-integrity verification — `apps/e2e-tests` is built: in-process flow specs (`flow1-approval-chain`, `flow2-eventing-fanout`, `flow3-outbox-dlq`) run now, plus Docker-gated live specs (`live/auth`, `live/rls-isolation`, `live/expense-approval`, `live/audit-chain`) driven against `E2E_BASE_URL`. _(Running the `live/` suite is the Docker-gated step.)_
- [x] Flow recording: per-flow annotated screen capture (what/expected/pass-fail), organized + shareable; tooling wired (deferred), format defined now
- [ ] Scheduled testing + bug-hunting agents (periodic/overnight) that run the flow catalogue, verify DB + cross-service correctness, append to `BUGLOG.md`

## Phase 11 — Frontend (ANALYSIS ONLY — no build yet)

- [x] Lightweight-UI options/effort/recommendation analysis completed. _(The standalone `docs/research/frontend-analysis.md` artifact was removed with the rest of `docs/research/`; the analysis-only decision and recommendation are recorded in `SPEC.md` §11.)_ **Owner reviews before any build (do not build yet).**

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
- 2026-06-26 — **Phase R reference-fidelity realignment** (SPEC.md §11): superseded the 2026-06-25
  "in-house RBAC+ABAC (not Casbin)" and the Redis event transport — `@aegis/access-control` now runs
  on **Casbin** (RBAC-with-domains, `dom`=tenantId; row-level scope kept as a separate layer) and
  `@aegis/events` now runs on **Kafka** (replacing `RedisBus`). Per-service refactor to the
  service-template shape (one-file-per-table models, per-aggregate repositories, per-resource
  controllers, validator middleware, thin index→bootstrap). Casbin migration 0009; tenant
  config/features 0010; outbox 0011.
- 2026-06-27 — **State-verification pass** (this update): cross-checked the tracker against the repo.
  Corrected migration count (0028 → **0031**); marked done the items that were already implemented but
  left unchecked — the "hello-tenant" slice (subsumed by the real PEP+RLS path), Kafka event bus +
  outbox, the shared approval engine, the cross-service event→rule→approval→notification chain,
  payroll field-level RBAC/masking + SoD maker-checker + idempotent inbound, the always-on
  cross-cutting checklist, the `apps/e2e-tests` harness, and the Phase 8 one-command-run deliverables.
  Recorded the genuinely-not-built remainders honestly: **live Swagger/`/api-docs` serving**, RFC-8693
  token exchange, reporting `fact_*` read models + access-scope result cache, scheduled
  reconcile/bug-hunting agents, and a missing `.vscode/launch.json` referenced by the ops doc. The
  **primary remaining gate stays the Docker-gated live E2E run.** Also removed dangling references to
  the deleted `docs/research/frontend-analysis.md` (decision now lives in SPEC.md §11).
