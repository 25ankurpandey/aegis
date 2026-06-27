# Aegis — Handoff & Onboarding

> **Read this first.** One self-contained document for a fresh agent or human reviewer to fully
> understand, run, test, and continue this platform with zero prior context. Every factual claim
> below was verified against the live repo at the time of writing (47 commits, HEAD `a683051`).
> When this doc and a deeper doc disagree, **`SPEC.md` is the single source of truth** — fix the
> drift, don't paper over it.

---

## 1. What this is

**Aegis is an enterprise, multi-tenant, microservices access-control platform.** It is a working
reference for getting authorization *right* across many services and many tenants at once:
centralized authorization (Casbin RBAC-with-domains + ABAC conditions, PDP/PEP/PAP/PIP split),
**database-enforced** tenant isolation (PostgreSQL Row-Level Security), signed service-to-service
tokens with strict context propagation, runtime role/permission management with no redeploy, a
multi-level approval engine, Kafka eventing with a transactional outbox + DLQ, and tamper-evident
hash-chained auditing.

It is a **gateway + 8 business services + shared libraries**, developed together in one Nx monorepo
for atomic cross-cutting changes but deployed and scaled as separate stateless processes. They talk
over HTTP (through the gateway and signed s2s calls) and a Kafka event bus — never by reaching into
each other's code.

### The 5 core use cases (what access control is demonstrated *on*)

1. **Identity & runtime access administration** — onboard a tenant, invite/register/login users
   (reference IdP issues permission-bearing JWTs), create roles/permissions and assign them **at
   runtime** (the PAP) with the change taking effect live (no redeploy).
2. **Expense lifecycle** — create → submit → multi-level approve → push to an ERP connector, with
   PDP allow/deny + own/team/all row scope enforced at every step.
3. **Invoice lifecycle** — receive → review → approve, header-level only, with a duplicate-entry
   guard (tenant + vendor + invoice_number + amount + currency) and ERP push.
4. **Payroll (highest-sensitivity)** — Draft → Calculated → Approved → Paid with **maker-checker**
   segregation of duties (the run approver must differ from the input editor), AES-256-GCM field
   encryption, audited PII reads, and an append-only disbursement ledger.
5. **Workflow + multi-level approvals** — a rules-as-data engine fires on domain events; the shared
   approval engine resolves manager-hierarchy / approver-group / threshold chains (parallel or
   sequential) with a progress log; reporting and notification ride the same event substrate.

---

## 2. Architecture

### Monorepo map

```
aegis/
├── apps/
│   ├── gateway/          # Edge: validate context, MINT X-Correlation-Id, route/proxy, bound timeouts
│   ├── user-management/  # Identity system-of-record + reference IdP + PAP; tenant config + feature flags
│   ├── expense/          # Expense reports + line expenses, approval state machine, ERP push
│   ├── invoice/          # Header-level invoice lifecycle + duplicate guard + ERP push
│   ├── payroll/          # Employees (encrypted), pay-run lifecycle + maker-checker, disbursement ledger
│   ├── reporting/        # CQRS-lite read models, async runs (202 + runId), RLS + column masking
│   ├── workflow/         # Rules-as-data engine (conditions + actions), event-triggered, per-run audit
│   ├── notification/     # Event-driven in-app + email + SMS, idempotent, never re-derives authority
│   ├── cli/              # Umzug migrations + seeders (PROCESS_TYPE=migration)
│   └── e2e-tests/        # In-process cross-service E2E suite + gated live suite (apps/e2e-tests/live)
└── libs/
    ├── service-core/     # RequestContext (AsyncLocalStorage), logging, typed errors+envelope,
    │                     #   context-propagating HttpClient + signed internal s2s tokens, config/secrets,
    │                     #   Redis cache + flag cache, middleware band, bootstrap + graceful shutdown
    ├── access-control/   # Casbin enforcer (RBAC+domains), policy loader + watcher (runtime reload),
    │                     #   ABAC condition evaluator, row-level scope, authenticate/authorize PEP guards
    ├── db/               # Non-owner Sequelize connection (so RLS bites), RLS helpers (SET LOCAL,
    │                     #   FORCE/RESTRICTIVE), tenant-scoped transactions, optimistic-lock base model, Umzug runner
    ├── events/           # Kafka bus (producer + back-pressure consumer + CommitManager), transactional
    │                     #   outbox + relay, topic/payload catalog, DLQ
    ├── approvals/        # Multi-level approval engine: policies, manager hierarchy, approver groups,
    │                     #   thresholds, next-approver resolver, progress log, parallel/sequential
    ├── connectors/       # Pluggable ERP framework (interface + registry + per-kind transformer) + mock
    │                     #   ERPs, durable sync-state + reconciliation
    ├── audit/            # Append-only, hash-chained tamper-evident audit log + verifyChain
    ├── activity/         # Generic append-only activity timeline any service writes to
    ├── shared/{enums,types,constants}/  # Domain enums (incl. HttpHeaderKey, TableName, dotted Permission
    │                     #   catalog), DTO/shape namespaces, per-area constants
    └── testing/          # Test fixtures (context stubs, principal/resource builders)
```

### One image, many roles — `PROCESS_TYPE` (verified in `scripts/start.sh`)

The whole monorepo builds into a single Docker image; the runtime role is selected by env in
`scripts/start.sh`, which has **exactly three cases**:

| `PROCESS_TYPE` | Behavior |
|---|---|
| `api` (default) | Run the HTTP service named by `SERVICE_NAME`. |
| `worker` | Run the same bundle with no HTTP listener; `bootstrap.ts` forks on `PROCESS_TYPE=worker` to swap in the Kafka transport and register topic consumers (workflow + notification). |
| `migration` | Run Umzug migrations + seeders (via `apps/cli`), then exit. |

> **IMPORTANT — there is NO `relay` `PROCESS_TYPE` case in `start.sh`.** The transactional outbox
> relay (`libs/events/src/init-relay.ts`, `OutboxRelay` in `outbox.ts`) runs **in-process inside the
> `api` pods**, not as a separate process role. (The README's capability table lists a `relay` row;
> that is aspirational/illustrative — the verified runtime reality is in-process in api pods. Trust
> `start.sh`.)

### The access-control substrate (the heart)

- **PDP / PEP / PAP / PIP** — the four standard policy points. PDP (`@aegis/access-control`)
  decides; PEP is the per-route guard band `authenticate → authorize(permission)`; PAP is
  user-management's runtime CRUD for roles/permissions/assignments; PIP supplies cached attributes.
- **RLS** — `FORCE ROW LEVEL SECURITY` + a `RESTRICTIVE` policy keyed on `app.current_tenant`; the
  app connects as a **non-owner without `BYPASSRLS`**, so a buggy query physically cannot cross
  tenants (`libs/db/src/rls.ts`). Tenant context is set per transaction via `SET LOCAL`.
- **Casbin** — `model.conf` is `sub, dom, act` with **`dom` = tenantId** (real tenant scoping, not
  the `'*'` hack). `authorize()` calls `enforce(role, tenant, permission)`, fail-closed.
  - **Runtime reload** — policy changes take effect live via a Casbin watcher
    (`libs/access-control/src/watcher.ts`, `policy-loader.ts`) — no redeploy, no migration.
  - **ABAC** — declarative conditions (approver up to $X, owner-only, status gates) evaluated by the
    PDP *after* RBAC passes (`condition-evaluator.ts`, `pdp.ts`).
- **Kafka + outbox + DLQ** — `kafkajs` producer (booted on every api pod) + back-pressure consumer
  + `CommitManager` (at-least-once). Events are staged inside the business transaction (no dual-write
  gap) and drained with `FOR UPDATE SKIP LOCKED` by the in-process relay. Retry-then-dead-letter
  (`topic.dlq`) on both transports — events are never silently swallowed.
- **Multi-level approval engine** (`libs/approvals/`) — policies → manager-hierarchy(level) →
  approver-groups(user/role/team/persona) → thresholds; a next-approver resolver + progress log;
  parallel (quorum) and sequential chains; payroll maker-checker double-guarded.
- **Connectors** (`libs/connectors/`) — pluggable ERP framework: a common connector interface +
  registry-as-factory-by-kind + per-kind transformer (domain entity → ERP payload), shipping
  neutral-named **mock** ERP connectors (no real ERP is called) + durable sync-state + reconciliation.
- **Service-to-service** — signed internal JWT (issuer/audience/exp) + an origin-header gate +
  propagated typed `X-Source-Service`; strict, fail-closed header validation in the context
  middleware (`X-Tenant-Id`, `X-Correlation-Id`, `X-Caller`, `X-Internal-Origin`,
  `X-Source-Service`) — never defaulted to `"UNKNOWN"`. `X-Correlation-Id` is THE single
  request-tracking id; there are no redundant tracing headers and no `entryContext` (see §11).

---

## 3. Status (verified)

- **Build: GREEN.** `npx nx run-many -t build --all` → **Successfully ran target build for 9
  projects** (cached on a clean tree).
- **Tests: GREEN for the committed tree.** `npx jest` →
  **628 passed, 9 skipped, 637 total** (102 suites passed, 4 skipped).
  - The **9 skipped** are the gated live E2E specs (real-stack only — see §5).
  - **2 suites currently fail to run** (`apps/payroll/test/consumers/record-update.consumer.spec.ts`
    and `apps/expense/test/services/expense-record-update.service.spec.ts`). These are **untracked
    orphan files** (`git status` shows them as `??`, not committed) left over from the **reverted**
    BUG-0011 partial implementation — they import a `record-update.consumer` module that no longer
    exists. They are NOT a regression in committed code; they represent the open bug and will
    disappear when BUG-0011 is redone (or the orphans are deleted). The committed tree builds and
    tests green.
- **History: 47 commits**, HEAD `a683051` (`docs(testkit): OpenAPI + offline API viewer, narrated
  per-suite demo scripts, testing guide; log BUG-0011`).
- **Bugs:** the 10 hunt-batch-1 bugs (BUG-0001…BUG-0010) are **ALL FIXED** in commit **`dffb79e`**
  (`fix(W5 batch 1): resolve all 10 confirmed BUGLOG bugs (incl. critical Casbin revocation)`),
  including the critical role-revocation gap (BUG-0008). **BUG-0011 is OPEN** — `assign_team`/
  `add_tag` rule actions publish `RecordUpdated` with no consumer, so team/tag annotations silently
  never persist (same orphan-topic class as BUG-0001/2). A partial impl was reverted and must be
  **redone completely**. See `BUGLOG.md`.
- **Scope:** Waves 1–5 complete, Wave 4 docs complete, and the E2E suite (in-process + gated live)
  complete. (`IMPLEMENTATION_PLAN.md` records Waves 1–4 status; Phase R reference-fidelity
  realignment is the current architecture-alignment lane.)

---

## 4. Run

```bash
npm ci                      # install (workspace-aware)
bash scripts/setup.sh       # one-command Docker bring-up (Postgres + Redis + Kafka + every service)
#   or:
bash scripts/dev-up.sh      # dev bring-up; same effect (VS Code: Cmd+Shift+B = "Aegis: Up")
```

`scripts/setup.sh` / `scripts/dev-up.sh` build every service image and bring up dockerized
**Postgres** (pre-seeded with the non-owner RLS app role via `scripts/db-init/`), **Redis**, and
**Kafka**, apply migrations + seeders, and run every service + worker + the in-process relay wired on
one Docker network. Per-service `.env` files are committed with internally-consistent dummy values so
`docker compose up` works end-to-end on a fresh machine with zero manual wiring.

- **Migrations / seeders** run as a one-shot task using the same image:
  `PROCESS_TYPE=migration` → `apps/cli` runs `migrate --auto-confirm` then
  `migrate-seeders --auto-confirm`.
- **Process role** is chosen by `PROCESS_TYPE` (`api` | `worker` | `migration`; see §2) +
  `SERVICE_NAME`.
- The gateway listens on **:4000**; the demo scripts target it there.

---

## 5. Test

| Layer | How | Where |
|---|---|---|
| **Unit + in-process integration** | `npx jest` (628 passing) | per-project `test/` folders |
| **In-process E2E** | cross-service suite that exercises real flows without Docker | `apps/e2e-tests/` (`src`, `test`) |
| **Gated live E2E** | runs against a running stack; **skipped unless `E2E_BASE_URL` is set** | `apps/e2e-tests/live/` — runbook: `docs/testing/LIVE_E2E_RUNBOOK.md` |
| **Narrated demo (curl)** | one command runs every suite A→G against the live gateway with STEP/EXPECT/PASS-FAIL narration; exits non-zero if any suite fails | `scripts/demo/run-all.sh` (+ per-suite `00…06-*.sh`, `lib.sh`) |
| **Manual API** | Postman collection + raw curl examples | `docs/postman/Aegis.postman_collection.json`, `docs/testing/CURL_EXAMPLES.md` |
| **API reference** | offline OpenAPI viewer | `docs/api/index.html` + `docs/api/openapi.yaml` |
| **Guides** | end-to-end testing guide + flow catalogue | `docs/testing/TESTING_GUIDE.md`, `docs/testing/flow-catalogue.md`, `docs/testing/FLOWS_v2.md` |

The **gated live E2E** is the Docker-gated layer: bring the stack up (§4), set `E2E_BASE_URL` to the
gateway URL, then run the live suite per `docs/testing/LIVE_E2E_RUNBOOK.md`. Without `E2E_BASE_URL`
those 9 specs are skipped (which is why a plain `npx jest` shows 9 skipped).

---

## 6. Record (annotated flow recordings)

Each demo suite is meant to be captured as one annotated recording with a TITLE / STEP / EXPECT /
VERDICT caption track (format defined in `docs/testing/flow-catalogue.md`).

- **`scripts/demo/record-all.sh`** wraps each suite in **asciinema** (`asciinema rec`) to produce one
  replayable terminal cast per suite under `docs/recordings/`.
- If asciinema is not installed, the script prints the macOS built-in screen-recording instruction
  (**Cmd+Shift+5**) per suite instead of failing — so recordings can be produced manually
  (Cmd+Shift+5 / QuickTime). One video per suite (A platform/tenancy, B identity, C access-control,
  D expense, E invoice, F workflow/approvals, G payroll).

---

## 7. Where to pick up

The platform is built by an **autonomous overnight loop**: a self-paced loop + scheduled wake-up that
auto-resumes after usage-limit windows (5-hourly) and overnight. Each pass is **small and
self-healing**: read `AGENTS.md` + `IMPLEMENTATION_PLAN.md`, advance the next unchecked tasks, run
and fix tests, update the plan + docs, then commit. The cycle is **fix → hunt → test**, and the
durable record lives in `BUGLOG.md`, `TEST_REPORT.md`, `NIGHTLY_LOG.md`, and the interactive
`docs/flows.html` dashboard.

**Immediate next work:**
1. **Redo BUG-0011 completely** — wire a `RecordUpdated` consumer so `assign_team`/`add_tag` rule
   actions persist team/tag annotations (columns + consumers + actual wiring + contract test). Then
   delete the two untracked orphan specs (or make them pass): `apps/payroll/test/consumers/
   record-update.consumer.spec.ts`, `apps/expense/test/services/expense-record-update.service.spec.ts`.
2. **Run the next bug-hunt batch** and append findings to `BUGLOG.md`.

**What is Docker-gated** (cannot be exercised without bringing the stack up): the full live run —
`scripts/setup.sh`/`dev-up.sh`, the narrated `scripts/demo/run-all.sh`, the recordings, and the gated
live E2E suite (`E2E_BASE_URL`). Everything else (build, unit + in-process E2E) runs without Docker.

---

## 8. Key files index

| Path | What |
|---|---|
| `SPEC.md` | **Single source of truth.** Locked decisions, model, layout, conventions, amendments §10/§11. |
| `IMPLEMENTATION_PLAN.md` | Phased/wave plan + status + decision log. |
| `README.md` | Public-facing platform showcase + capability table. |
| `AGENTS.md` | How autonomous passes operate; read at the start of every pass. |
| `BUGLOG.md` | Append-only bug log (BUG-0001…0010 fixed @ `dffb79e`; BUG-0011 open). |
| `scripts/start.sh` | `PROCESS_TYPE` entrypoint switch (`api`/`worker`/`migration`). |
| `scripts/setup.sh`, `scripts/dev-up.sh` | One-command Docker bring-up. |
| `scripts/db-init/` | Postgres init (non-owner RLS app role + databases). |
| `scripts/demo/run-all.sh`, `record-all.sh`, `00…06-*.sh`, `lib.sh` | Narrated curl demo + recording. |
| `docs/testing/flow-catalogue.md`, `FLOWS_v2.md` | Numbered E2E flow catalogue + executable companion. |
| `docs/testing/TESTING_GUIDE.md`, `LIVE_E2E_RUNBOOK.md`, `CURL_EXAMPLES.md` | Testing guides + live runbook + curl. |
| `docs/api/index.html`, `docs/api/openapi.yaml` | Offline API reference. |
| `docs/postman/Aegis.postman_collection.json` | Postman collection. |
| `apps/e2e-tests/` (+ `live/`) | In-process E2E suite + gated live suite. |
| `libs/access-control/`, `libs/db/`, `libs/events/`, `libs/approvals/`, `libs/connectors/` | The substrate: Casbin/PEP, RLS, Kafka+outbox+DLQ, approval engine, ERP connectors. |

---

## 9. Recording runbook (agent-executable)

> Goal: produce **one short video per demo suite (A–G)** — seven videos, each well under 5 minutes —
> capturing the self-narrated `STEP → EXPECT → PASS/FAIL` banners + the real request/response traffic.
> Seven videos × <5 min sits comfortably inside the Loom free tier (25 videos × 5 min). This is the
> human-in-the-loop path; the asciinema path below is the fully autonomous fallback.

**Prerequisite (once):** bring the full stack up — this is the Docker-gated step.

```bash
bash scripts/setup.sh     # Postgres(+RLS) + Redis + Kafka + gateway:4000 + 4001-4007 + workers + relay
```

`setup.sh` polls `/health` on every service and prints the ready URLs + seeded demo credentials
(`admin@demo-org.test` / `demo-admin-pw`, tenant `00000000-0000-4000-8000-000000000001`). Every demo
also self-gates on `/health` and points back here if the stack is down. Install `jq` if missing
(`brew install jq`).

**Per-suite loop (Loom, human + agent).** Each suite is independent — record them in any order; one
video each. For suite *NN-name* (the seven below):

1. **Human:** start the Loom recorder (Start Recording), framing the terminal.
2. **Agent:** run the suite via the shell — it self-narrates STEP banners and prints each
   request/response and a PASS/FAIL verdict, exiting non-zero if any assertion fails:

   ```bash
   bash scripts/demo/00-platform-tenancy.sh     # Suite A — platform & tenancy
   bash scripts/demo/01-identity.sh             # Suite B — identity & sessions
   bash scripts/demo/02-access-control.sh       # Suite C — access-control core (PAP + cross-tenant must-fail)
   bash scripts/demo/03-expense.sh              # Suite D — expense lifecycle → approval engine → ERP push
   bash scripts/demo/04-invoice.sh              # Suite E — invoice lifecycle + duplicate guard
   bash scripts/demo/05-workflow-approvals.sh   # Suite F — rules-as-data + multi-level approvals
   bash scripts/demo/06-payroll.sh              # Suite G — payroll, maker-checker SoD, disburse gate
   ```

3. **Human:** when the suite prints its roll-up verdict, stop + save the Loom recording; name it for
   the suite (e.g. `Aegis — Suite D — Expense`). That's one video.

Repeat for each of the seven suites. (`scripts/demo/run-all.sh` runs A→G back-to-back with a single
roll-up summary — useful for a one-shot smoke test, but for clean per-suite videos record the
individual scripts above so each video maps 1:1 to a suite.)

**Autonomous fallback (no human, no Loom):**

```bash
bash scripts/demo/record-all.sh
```

Wraps each suite in `asciinema rec` → one replayable `.cast` per suite under `docs/recordings/`
(capturing the same STEP/EXPECT/PASS-FAIL narration + real traffic). If `asciinema` is not installed
it prints the macOS built-in screen-recording instructions (`Cmd+Shift+5`) per suite instead of
failing, so the recordings can still be produced manually. Casts replay with `asciinema play <cast>`
and convert to GIF/SVG (`agg <cast> out.gif`) for sharing without re-running the stack.

> Honest scope: a few catalogue behaviors are **async side effects** (connector ERP push, notification
> fan-out, the audit hash-chain, the double-entry ledger). The demos exercise the synchronous trigger
> and surface the resulting state; the row-level side-effect assertions live in
> `docs/testing/LIVE_E2E_RUNBOOK.md` (direct `psql`). For deeper context on each suite, see
> `docs/testing/TESTING_GUIDE.md` and `docs/testing/flow-catalogue.md`.

---

## 10. Reference provenance map

> This section records what each capability was *referenced from*, using each reference's generic
> role only. External codebases are **references only** — nothing is copied verbatim with branding,
> and no external reference identifier appears in shipped code or docs (see §11). The table maps each
> capability → the reference role it was learned from → the reference area → our neutral,
> from-scratch file(s).

| Capability | Reference role | Reference area | Our file(s) |
|---|---|---|---|
| Service bootstrap + one-image-many-roles (`PROCESS_TYPE`) | the architecture reference | service bootstrap + `start` entrypoint dispatch | `libs/service-core/src/bootstrap/bootstrap.ts`, `scripts/start.sh` |
| Kafka client (producer / consumer / commit) | the architecture reference | kafka client wrapper | `libs/events/src/kafka-bus.ts` (+ `bus.ts`, `outbox.ts`) |
| Request-context propagation (AsyncLocalStorage + header band) | the architecture reference | request-context / context middleware | `libs/service-core/src/context/request-context.ts`, `libs/service-core/src/middleware/context.middleware.ts` |
| Typed error + error-envelope response shape | the architecture reference | error utils + error middleware | `libs/service-core/src/errors/error-utils.ts`, `libs/service-core/src/middleware/error.middleware.ts` |
| Constants-as-single-source pattern | the architecture reference | constants modules | `libs/shared/constants/src/*.constants.ts`, `libs/shared/enums/src/table-name.enum.ts` |
| Casbin **with domains** (RBAC + `dom`=tenantId) | the domain reference | Casbin model/enforcer + pg adapter usage | `libs/access-control/src/enforcer.ts`, `libs/access-control/src/pdp.ts`, `apps/cli/src/migrations/0009_casbin.ts` |
| Multi-level approval engine | the domain reference | approval engine / resolver | `libs/approvals/src/approval.service.ts`, `libs/approvals/src/resolver.ts`, `libs/approvals/src/models/*` |
| Multi-tenancy + RLS (non-owner role, `SET LOCAL`, FORCE/RESTRICTIVE) | the domain reference | tenancy / RLS enforcement | `libs/db/src/rls.ts`, `scripts/db-init/` |
| Labels / tags | the domain reference | label/tag model + filtering | workflow rule actions `assign_team`/`add_tag` (`apps/workflow/src/`), activity/annotation columns (see BUG-0011) |
| Tenant-config + feature flags | the domain reference | tenant config / feature-flag store | `apps/user-management/src/models/{tenant-config,tenant-feature}.model.ts` |
| ERP connector: adapter + transformer + sync-state | the ERP-integration reference | connector adapter / transformer / sync-state | `libs/connectors/src/{connector,transformer,base-connector,sync-state}.ts`, `libs/connectors/src/mock/*` |
| Email provider (nodemailer transport) | the email-provider reference | nodemailer email send | `apps/notification/src/services/email-provider.service.ts` |

> Deeper per-area provenance + the "what we kept / changed / rejected" analysis lives in `docs/analysis/`
> (e.g. `A3-kafka.md`, `A4-crosscutting.md`, `B1-approvals.md`, `EMAIL_alignment.md`,
> `ERP_proxy_alignment.md`) — those analysis docs are the other permitted home for reference provenance.

---

## 11. Hard constraints (naming)

> These rules define what may appear in the repo. Use only the `@aegis/*` scope and Aegis domain
> names — do not reference external reference codebases, their internal packages, or their customers
> by name anywhere (the sole exception is the §10 reference-provenance map and the `docs/analysis/`
> provenance docs, which record references by generic role).

- **No external reference / customer names.** The codebase MUST NOT contain external reference-codebase
  identifiers, their internal package names, or their customer/vendor/ERP brand names. External
  codebases are **references only**; nothing is copied verbatim with branding. The npm scope is
  `@aegis/*`; service/header/table names use neutral, domain-accurate terms.
- **No exercise / evaluation framing.** No wording that frames this as an exercise, evaluation, or
  review submission — Aegis is presented as a production enterprise platform.
- **One tracking header.** `X-Correlation-Id` only; no `X-Trace-Id`/`X-Trend`/`X-Tracker`. No
  `entryContext`.
