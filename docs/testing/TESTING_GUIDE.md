# Aegis — Testing Guide

The single guide a reviewer follows to **bring the platform up, test it three ways, exercise every
flow, and record the results** — using only free tools.

Aegis is an enterprise access-control platform built to a requirements specification: an Nx monorepo
of eight HTTP services (a **gateway** plus seven business services — `user-management`, `expense`,
`payroll`, `reporting`, `workflow`, `notification`, `invoice`) and a `cli`, sharing a central
access-control library, with tenant isolation enforced in **PostgreSQL Row-Level Security**, a shared
approval engine, a Kafka event backbone (outbox → consumers → DLQ), and a tamper-evident audit
hash-chain.

> **Source of truth.** The behaviour this guide tests is defined by [`../../SPEC.md`](../../SPEC.md)
> and catalogued flow-by-flow in [`flow-catalogue.md`](./flow-catalogue.md) (rendered:
> [`../flows.html`](../flows.html)). Where this guide and the catalogue differ on whether a step is
> *implemented* vs *aspirational*, the per-flow `gap` notes in `flows.html` win.

---

## 1. Prerequisites

You need exactly **two** things. There is one external runtime dependency — Docker.

| Tool | Why | Check | Install |
|---|---|---|---|
| **Docker Desktop** (Engine + Compose v2) | The only external dependency. Runs Postgres, Redis, Kafka, all 9 services, and the 2 Kafka workers as one stack. | `docker info` (daemon up) and `docker compose version` (v2) both succeed | <https://docs.docker.com/get-docker/> |
| **Node.js ≥ 20** + npm | Runs the in-repo unit/integration suite and the live HTTP suite (`npx jest`). Not needed if you only run the dockerized stack + curl/Postman. | `node -v` → v20+ | <https://nodejs.org/> |

Optional, only for the manual/curl path and recordings:

| Tool | Why | Install |
|---|---|---|
| `curl` + `jq` | Copy-paste API calls in [`CURL_EXAMPLES.md`](./CURL_EXAMPLES.md) | `jq`: `brew install jq` |
| Postman | GUI alternative to curl | <https://www.postman.com/downloads/> (free tier is enough) |
| `asciinema` | Free, scriptable terminal-cast recorder (see §6) | `brew install asciinema` |

> First time? Run `npm ci` once at the repo root so `npx jest` resolves dependencies. The dockerized
> stack does **not** need this — it builds inside the image.

---

## 2. One-command setup

From a fresh checkout, at the repo root:

```bash
bash scripts/setup.sh
```

This is **idempotent and re-runnable** (safe after a crash, a code change, or a `down` — volumes are
kept). It:

1. **Preflights Docker** — verifies `docker`, `docker compose version`, and a running daemon
   (`docker info`); exits non-zero with an install pointer if any is missing.
2. **Builds the single image** and brings the whole stack up on one Docker network
   (`docker compose -f docker-compose.all.yml up -d --build`). One image serves every role via
   `PROCESS_TYPE` (api / worker / migration) — see [`../../Dockerfile`](../../Dockerfile) and
   [`../../scripts/start.sh`](../../scripts/start.sh).
3. **Waits for Postgres**, then runs the one-shot **migrate** container
   (`PROCESS_TYPE=migration` → migrations **then** seeders; both idempotent).
4. **Polls `/health`** on the gateway and all seven services until each is ready (or times out with a
   diagnostic log dump).
5. Prints the **ready URLs, seeded credentials, and next steps**.

### What comes up

| Component | Where |
|---|---|
| **Gateway** (single entry point) | `http://localhost:4000` |
| user-management | `http://localhost:4001` |
| expense | `http://localhost:4002` |
| payroll | `http://localhost:4003` |
| reporting | `http://localhost:4004` |
| workflow | `http://localhost:4005` |
| notification | `http://localhost:4006` |
| invoice | `http://localhost:4007` |
| **Kafka workers** (no HTTP port) | `workflow-worker`, `notification-worker` |
| Infra | Postgres `:5432`, Redis `:6379`, Kafka `:9092` |

> `scripts/dev-up.sh` is a thinner equivalent (build + up + migrate, no health gate) used by the live
> E2E harness. Prefer `setup.sh` for a guided bring-up.

### Confirm health

```bash
# Gateway + every service:
curl -s http://localhost:4000/health | jq
for p in 4001 4002 4003 4004 4005 4006 4007; do
  printf 'port %s: ' "$p"; curl -s "http://localhost:$p/health" | jq -c .
done
# Each → {"service":"...","status":"ok","uptime":...}

# Deep check (DB + cache) on any service:
curl -s "http://localhost:4002/health?details=true" | jq
# → {"service":"expense","status":"ok","db":true,"cache":true}

# Stack state:
docker compose -f docker-compose.all.yml ps
```

### Seeded fixtures (login works immediately)

| Tenant | `x-tenant-id` | admin email / password |
|---|---|---|
| **A** (Demo Org) | `00000000-0000-4000-8000-000000000001` | `admin@demo-org.test` / `demo-admin-pw` |
| **B** (Demo Org B) | `00000000-0000-4000-8000-000000000002` | `admin@demo-org-b.test` / `demo-admin-pw-b` |

The seeded admin holds **every permission**, so one login drives all flows. Tenant B exists so
cross-tenant RLS isolation is push-button.

**Every gateway request needs headers:**

- `x-tenant-id: <tenant UUID>` — **required, fail-closed**; never defaulted.
- `x-correlation-id: <any id>` — optional inbound (gateway mints one), **echoed back** for log grep.
- `authorization: Bearer <jwt>` — every route except `/user-management/v1/auth/register` and
  `/user-management/v1/auth/login`.

---

## 3. Three ways to test

Pick the depth you need. (a) needs only Node; (b) and (c) need the dockerized stack from §2.

### (a) Automated unit + integration — no Docker

The in-process suite runs with mocked I/O where possible — no stack required. Prefer Nx in normal
developer shells; use direct Jest configs if the local sandbox blocks the Nx daemon socket.

```bash
# Everything:
npx jest

# A single project / area:
npx jest libs/access-control       # PDP/PEP/PAP + Casbin + ABAC
npx jest apps/expense              # one service
npx jest libs/audit                # hash-chain unit tests

# Via Nx (same tests, with caching):
npx nx run-many -t test --all
npx nx test access-control

# Direct project fallback when Nx daemon/plugin workers cannot start:
npx jest --config apps/notification/jest.config.ts --runInBand
npx jest --config apps/reporting/jest.config.ts --runInBand
npx jest --config apps/payroll/jest.config.ts --runInBand
```

**In-process cross-service suite** — the closest thing to E2E **without** Docker. It wires real
service classes together and drives multi-service flows (approval chain, event fan-out, outbox/DLQ)
in one process:

```bash
npx jest apps/e2e-tests
# or: npx nx test e2e-tests
```

| Spec | Flow exercised |
|---|---|
| `apps/e2e-tests/test/flow1-approval-chain.spec.ts` | submit → shared approval engine → decide |
| `apps/e2e-tests/test/flow2-eventing-fanout.spec.ts` | domain event → consumer → notification fan-out |
| `apps/e2e-tests/test/flow3-outbox-dlq.spec.ts` | outbox publish + dead-letter handling |

> The live HTTP specs under `apps/e2e-tests/live/*.e2e.spec.ts` are **collected but skipped** during a
> plain `npx jest` (they self-gate on `E2E_BASE_URL`). They run only against a live stack — see §6.

### (b) Live API, scripted — against the running stack

With the stack up (§2), drive the public gateway end-to-end exactly as an external client would, in
two complementary ways:

**1. The live HTTP jest suite** (programmatic assertions of the live flows):

```bash
# Auth, expense approval chain, cross-tenant RLS isolation:
E2E_BASE_URL=http://localhost:4000 npx jest apps/e2e-tests/live

# Add the audit hash-chain re-walk (needs a direct Postgres DSN — see §6):
E2E_BASE_URL=http://localhost:4000 \
E2E_DATABASE_URL=postgres://aegis_owner:aegis_local@localhost:5432/aegis \
  npx jest apps/e2e-tests/live
```

**2. The curl recipe walk-through** — every flow as copy-paste commands, in order:

```bash
# Open and follow top-to-bottom (sets $GW/$TA/$TB, logs in, runs each suite):
open docs/testing/CURL_EXAMPLES.md   # or just read it
```

> **Optional convenience wrapper.** If you want a one-shot "run the whole live walk-through"
> command, copy the blocks from [`CURL_EXAMPLES.md`](./CURL_EXAMPLES.md) into a local
> `scripts/demo/run-all.sh` (and per-suite scripts) and `chmod +x` them. These are **not shipped**
> in the repo — the curl doc and the live jest suite above are the maintained scripted paths.

### (c) Manual — Postman or curl + the API docs

**Postman:** import [`../postman/Aegis.postman_collection.json`](../postman/Aegis.postman_collection.json),
set the `{{baseUrl}}` collection variable to `http://localhost:4000`, run **Login** (it saves the JWT
into `{{token}}`), then run the requests top-to-bottom.

**curl:** follow [`CURL_EXAMPLES.md`](./CURL_EXAMPLES.md) (copy-paste, in order). Needs `curl` + `jq`.

**API reference** while you poke around: the numbered docs in [`../`](../) (e.g.
[`05-authn-authz-flow.md`](../05-authn-authz-flow.md), [`08-api-conventions.md`](../08-api-conventions.md))
and the per-service contracts under [`../services/`](../services/).

---

## 4. The flows

Suites **A–J** are catalogued in [`flow-catalogue.md`](./flow-catalogue.md) (dashboard:
[`../flows.html`](../flows.html)). The deliverable focuses on the core suites **A–G**; the table below
maps **every** suite to the script that exercises it and the expected result. "Implemented vs
aspirational" reflects the `gap` notes in `flows.html` — treat those as authoritative.

| Suite | Flows | Exercise it with | Expected result |
|---|---|---|---|
| **A. Platform & tenancy foundation** | FLOW-001…003 | `bash scripts/setup.sh` (bootstrap + migrate); `/health` checks (§2) | Stack up; the `0001..0021` migration set + seeders `0001..0005` applied; every `/health` → `ok`. *FLOW-002 tenant onboarding is seeder-provisioned (no public POST /tenants).* |
| **B. Identity & sessions** | FLOW-010…014 | `CURL_EXAMPLES.md §1`; `apps/e2e-tests/live/auth.e2e.spec.ts` | Register 201; login → JWT + session row; `/me` 200 with roles+permissions; session list/revoke APIs; missing tenant header → fail-closed 4xx. *Invite issue/revoke is shipped; invite-token acceptance remains hardening.* |
| **C. Access-control core (PDP/PEP/PAP)** | FLOW-020…024 | `CURL_EXAMPLES.md §1 (cross-tenant) + §2`; `apps/e2e-tests/live/rls-isolation.e2e.spec.ts`; `npx jest libs/access-control` | Allowed decision succeeds (RBAC+ABAC); denied → fail-closed 403; tenant-A token + tenant-B header → 403 at the PEP; cross-tenant rows → 404 (RLS). |
| **D. Expense lifecycle** | FLOW-030…033 | `CURL_EXAMPLES.md §2`; `apps/e2e-tests/live/expense-approval.e2e.spec.ts`; `apps/e2e-tests/test/flow1-approval-chain.spec.ts` | create (open) → attach item → submit (→ approvals, emits `expense.submitted`) → decide → read back `approved`. |
| **E. Invoice lifecycle** | FLOW-040…042 | `CURL_EXAMPLES.md §3` | create → submit → approve; duplicate (same vendor+number+amount+currency) is **flagged** `duplicate` (201, not rejected); variance hold then approve. |
| **F. Workflow & approvals** | FLOW-050…052 | `apps/e2e-tests/test/flow1-approval-chain.spec.ts` + `flow2-eventing-fanout.spec.ts`; live expense submit (§b) | rule fires on a domain event; multi-level chain advances; delegated approval (sub+act) decides. |
| **G. Payroll (high-sensitivity)** | FLOW-060…064 | `CURL_EXAMPLES.md §4` | draft → calculate → **maker-checker** (requester approve → 403 SoD) → separate approver → disburse (idempotent via `Idempotency-Key`); sensitive fields masked on read. |
| **H. Reporting** | FLOW-070…071 | `CURL_EXAMPLES.md §6` | define → run (async, 202 + `runId`) → poll → `succeeded` with `artifact_url`; column masking applied; scope-keyed cache (no cross-user leak). |
| **I. Notification** | FLOW-080…081 | `apps/e2e-tests/test/flow2-eventing-fanout.spec.ts`; live runbook §4 side-effects | idempotent delivery (replays are no-ops); in-app inbox scoped per user/tenant. |
| **J. Service-to-service & integrity** | FLOW-090…093 | `apps/e2e-tests/test/flow3-outbox-dlq.spec.ts`; `audit-chain.e2e.spec.ts` (live, double-gated) | strict header validation; internal JWT downscope; connector mock-ERP push; audit hash-chain re-walk verifies (tamper-evident). |

---

## 5. Recording the results — free tools only

> For the **step-by-step per-suite recording runbook** (the exact agent-executable order: stack-up →
> per-suite Loom record → which `scripts/demo/<NN-suite>.sh` to run → stop/save, plus the autonomous
> asciinema fallback), see **`HANDOFF.md` §9 "Recording runbook"**. This section covers the recorder
> tooling itself.

You do **not** need Loom or any paid recorder. Use what ships free with macOS plus one optional brew
package.

**Screen video (built-in, zero install):**

- **macOS screen recorder** — `Cmd + Shift + 5` → choose *Record Selected Portion* or *Record Entire
  Screen* → *Record*. Stop from the menu bar. Saves an `.mov` to the Desktop. Use this for the
  Postman / browser / dashboard paths.
- **QuickTime Player** — *File → New Screen Recording*. Same engine; handy if you want to trim before
  saving.

**Terminal casts (lightweight, scriptable, free):**

```bash
brew install asciinema
asciinema rec FLOW-D-expense.cast        # records the terminal session
# ...run the suite or curl block...
exit                                     # or Ctrl-D stops the recording
asciinema play FLOW-D-expense.cast       # replay locally
```

A `.cast` is tiny (text, not video), diffable, and replays at native speed — ideal for the curl and
`npx jest` paths.

> **Optional record-all wrapper.** If you want each suite captured unattended, you can wrap the §3/§4
> commands in a local `scripts/demo/record-all.sh` that loops over suites calling `asciinema rec`.
> Like the demo runner in §3(b), this is **not shipped** — build it from the curl/jest commands above
> if you want it.

**Organization — one video per suite + a naming convention.** Record **one clip per suite (A–J)** so
each maps cleanly to the catalogue. Suggested filename:

```
aegis_<SUITE-LETTER>_<flow-range>_<path>.<ext>
# examples:
aegis_D_FLOW-030-033_expense_curl.cast
aegis_G_FLOW-060-064_payroll_curl.mov
aegis_C_FLOW-020-024_accesscontrol_jest.cast
```

Drop the files in one folder (e.g. `~/Desktop/aegis-recordings/`) named for the suite letter so a
reviewer can step A → J in order.

---

## 6. Live E2E (dockerized, HTTP through the gateway)

For a full live run with **side-effect assertions** (event outbox drained, notification fan-out,
audit hash-chain, DLQ) follow the manual runbook, and/or run its programmatic twin:

- **Manual runbook:** [`LIVE_E2E_RUNBOOK.md`](./LIVE_E2E_RUNBOOK.md) — bring-up, fixtures, every flow
  with `psql` side-effect checks.
- **Programmatic live suite:** `apps/e2e-tests/live/` (see [`its README`](../../apps/e2e-tests/live/README.md)).
  It is **`E2E_BASE_URL`-gated** — inert under plain `npx jest`, active only when pointed at a live
  stack:

```bash
# 1) Stack up + migrate/seed:
bash scripts/setup.sh        # (or scripts/dev-up.sh)

# 2) HTTP flows (auth, expense approval chain, RLS isolation A vs B):
E2E_BASE_URL=http://localhost:4000 npx jest apps/e2e-tests/live

# 3) Add the audit hash-chain re-walk (double-gated — also needs a direct DSN):
E2E_BASE_URL=http://localhost:4000 \
E2E_DATABASE_URL=postgres://aegis_owner:aegis_local@localhost:5432/aegis \
  npx jest apps/e2e-tests/live
```

With no env set, `npx jest apps/e2e-tests/live` runs **0 specs** (all skipped) — by design.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Docker is not installed` / `daemon is not running` from `setup.sh` | Start Docker Desktop (or `sudo systemctl start docker` on Linux); wait for *running*; re-run `bash scripts/setup.sh`. |
| `Docker Compose v2 is not available` | Update Docker Desktop or install the Compose v2 plugin: <https://docs.docker.com/compose/install/>. The repo uses `docker compose` (v2) syntax. |
| A service never reports healthy (timeout) | `setup.sh` dumps the last log lines on timeout. Inspect: `docker compose -f docker-compose.all.yml logs --tail 80 <service>`. Re-running `setup.sh` is safe (it reconciles and retries). |
| Port already in use (4000–4007, 5432, 6379, 9092) | Another process owns the port. Find it (`lsof -i :4000`) and stop it, or stop the conflicting stack, then re-run. |
| `Postgres did not become ready within 120s` | Low resources or a stuck container. `docker compose -f docker-compose.all.yml logs postgres`; bump the budget via `AEGIS_HEALTH_TIMEOUT=300 bash scripts/setup.sh`. |
| Migrations/seeders look missing | They are idempotent and re-applied on every `setup.sh`. Verify: `docker compose -f docker-compose.all.yml run --rm -e PROCESS_TYPE=migration migrate` (expects the current `0001..0026` migration set in `apps/cli/src/migrations/` and seeders `0001..0006`). |
| `401`/`403` on a request that should pass | Missing/expired JWT, or missing/mismatched `x-tenant-id`. A tenant-A token with a tenant-B header is **supposed** to 403 (defense-in-depth PEP). Re-login (`CURL_EXAMPLES.md §1`). |
| `npx jest apps/e2e-tests/live` runs 0 tests | Expected without `E2E_BASE_URL`. Set it (and `E2E_DATABASE_URL` for the audit-chain spec) — see §6. |
| `npx jest` fails to resolve deps | Run `npm ci` at the repo root once. |
| Want a clean slate | `docker compose -f docker-compose.all.yml down -v` (wipes Postgres + Kafka volumes), then `bash scripts/setup.sh`. Plain `down` (no `-v`) keeps data. |

### Manage the stack

```bash
docker compose -f docker-compose.all.yml ps                     # status
docker compose -f docker-compose.all.yml logs -f gateway expense # tail logs
docker compose -f docker-compose.all.yml down                   # stop (keeps volumes)
docker compose -f docker-compose.all.yml down -v                # reset (wipes volumes)
bash scripts/setup.sh                                           # re-run (idempotent)
```

---

### Quick reference

| I want to… | Run |
|---|---|
| Bring the platform up | `bash scripts/setup.sh` |
| Run all 583 unit/integration tests | `npx jest` |
| Run the in-process cross-service suite | `npx jest apps/e2e-tests` |
| Run the live HTTP suite | `E2E_BASE_URL=http://localhost:4000 npx jest apps/e2e-tests/live` |
| Drive the API by hand (curl) | follow [`CURL_EXAMPLES.md`](./CURL_EXAMPLES.md) |
| Drive the API by hand (GUI) | import [`Aegis.postman_collection.json`](../postman/Aegis.postman_collection.json) |
| Full live run with side-effect checks | [`LIVE_E2E_RUNBOOK.md`](./LIVE_E2E_RUNBOOK.md) |
| See every flow's status | [`flow-catalogue.md`](./flow-catalogue.md) / [`../flows.html`](../flows.html) |
