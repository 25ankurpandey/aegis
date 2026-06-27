# Aegis — Live Dockerized E2E Runbook

> **Status:** push-button procedure to run the **`E2E`-tier** flows from
> [`FLOWS_v2.md`](./FLOWS_v2.md) + [`flow-catalogue.md`](./flow-catalogue.md) against a **real**
> dockerized stack (Postgres + RLS, Redis, Kafka, all 9 services, the workflow/notification workers,
> producer-on-every-pod + the transactional-outbox relay). Docker is **not** available on the authoring
> machine, so nothing here was executed live — it is written to be run verbatim the moment a Docker host
> exists. Every step lists its **expected** result and how to read logs / the DLQ.
>
> Two ways to drive the flows once the stack is up:
> 1. **By hand** — the `curl` recipes in §4–§9 (copy/paste, asserts inline).
> 2. **Automated** — the gated jest harness in [`apps/e2e-tests/live/`](../../apps/e2e-tests/live)
>    (§10). Same flows, asserted programmatically; SKIPPED unless `E2E_BASE_URL` is set.

---

## 0. Prerequisites

- Docker + Docker Compose v2 (`docker compose version` ≥ 2).
- Repo checked out; run everything from the repo root.
- Ports free on the host: `4000`–`4007` (services), `5432` (Postgres), `6379` (Redis), `9092` (Kafka).
- `curl` and `jq` for the manual recipes; `node`/`npx` for the automated harness.

The stack uses **committed dummy secrets** (the `apps/*/.env` files) so there is zero manual env setup.
The runtime DB role is **`aegis_app`** — a **NON-OWNER** with `NOBYPASSRLS`, so Row-Level Security is
genuinely enforced. Migrations run as the **`aegis_owner`** role (DDL needs ownership).

---

## 1. Bring the stack up

```bash
bash scripts/dev-up.sh
```

This (`scripts/dev-up.sh` → `docker-compose.all.yml`):
1. Builds the single `aegis:local` image (one image, every role selected by `PROCESS_TYPE`).
2. Starts `postgres` (runs `scripts/db-init/01-init.sql` → creates the non-owner `aegis_app` role +
   default privileges), `redis`, and `kafka` (single-broker KRaft, no ZooKeeper).
3. Waits for Postgres health.
4. Runs the **one-shot `migrate`** container (`PROCESS_TYPE=migration`): applies all 20 schema
   migrations **then** the 5 seeders (system roles → demo tenant A → casbin policies → approval
   policies → **demo tenant B**).
5. Leaves every service + the two workers running on the `aegis` network.

**Expected** — `docker compose -f docker-compose.all.yml ps` shows all of: `postgres`, `redis`,
`kafka` (healthy), `gateway`, `user-management`, `expense`, `payroll`, `reporting`, `workflow`,
`workflow-worker`, `notification`, `notification-worker`, `invoice` **up**, and the one-shot `migrate`
container **exited 0**.

> If `migrate` did not run (e.g. you brought the stack up with `docker compose up` directly), run it
> explicitly — it is in the `tools` profile so it does not auto-start:
> ```bash
> docker compose -f docker-compose.all.yml run --rm -e PROCESS_TYPE=migration migrate
> ```

### Verify migrations + seeders landed

```bash
# Migrations recorded (expect the 0001..0020 list):
docker compose -f docker-compose.all.yml exec -T postgres \
  psql -U aegis_owner -d aegis -c "SELECT name FROM migrations ORDER BY name;"

# Seeders recorded (expect 0001_system_roles .. 0005_demo_tenant_b):
docker compose -f docker-compose.all.yml exec -T postgres \
  psql -U aegis_owner -d aegis -c "SELECT name FROM seeder_meta ORDER BY name;"
```

> The seeder-meta table name may differ by Umzug config; if `seeder_meta` is empty, check the
> `migrate` container logs for the `[seed] demo tenant ...` and `[seed] demo tenant B ...` lines —
> those prove both tenants seeded.

### Health gate

```bash
curl -s http://localhost:4000/health | jq    # gateway — bypasses all middleware
for p in 4001 4002 4003 4004 4005 4006 4007; do
  echo "port $p:"; curl -s "http://localhost:$p/health" | jq -c .
done
```

**Expected** — each returns `{"service": "...", "status": "ok", ...}`.

---

## 2. Seeded fixtures

| Tenant | `x-tenant-id` (UUID) | Admin email | Password |
|---|---|---|---|
| **A** (Demo Org)   | `00000000-0000-4000-8000-000000000001` | `admin@demo-org.test`   | `demo-admin-pw`   |
| **B** (Demo Org B) | `00000000-0000-4000-8000-000000000002` | `admin@demo-org-b.test` | `demo-admin-pw-b` |

Both admins hold the shared `admin` system role (all permissions). Tenant B exists **only** to make
cross-tenant RLS isolation push-button (`apps/cli/src/seeders/0005_demo_tenant_b.ts`).

### Required request headers (every call goes through the gateway on `:4000`)

- `x-tenant-id: <tenant UUID>` — **required, fail-closed** (the context middleware rejects a missing
  tenant with a 4xx; it never defaults).
- `x-correlation-id: <any id>` — optional inbound (the gateway mints one if absent) but **echoed back**
  so you can grep logs by it.
- `authorization: Bearer <jwt>` — for every authenticated route (everything except
  `/user-management/v1/auth/register` and `/.../auth/login`).

> Route prefix = first path segment → service (`apps/gateway/src/routes-config.ts`), e.g.
> `/expense/...` → expense service. Public API version prefix is `/v1`.

Convenience env for the recipes below:

```bash
export GW=http://localhost:4000
export TA=00000000-0000-4000-8000-000000000001
export TB=00000000-0000-4000-8000-000000000002
```

---

## 3. Register → Login → JWT  (FV2 auth / flow-catalogue auth)

```bash
# 3a. Register a fresh user in tenant A (tenant comes from the HEADER, not the body).
curl -s -X POST "$GW/user-management/v1/auth/register" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" \
  -d '{"email":"e2e-user@demo-org.test","password":"e2e-password-123","firstName":"E2E","lastName":"User"}' | jq
# Expected: 201 { "id": "...", "email": "e2e-user@demo-org.test" }

# 3b. Log in the seeded admin → JWT.
TOKEN_A=$(curl -s -X POST "$GW/user-management/v1/auth/login" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" \
  -d '{"email":"admin@demo-org.test","password":"demo-admin-pw"}' | jq -r .token)
echo "$TOKEN_A" | cut -c1-24    # Expected: a 3-part JWT (header.payload.signature)

# 3c. The JWT is accepted by an authenticated route.
curl -s "$GW/user-management/v1/auth/me" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq
# Expected: 200 { "id": "...", "email": "admin@demo-org.test", "roles": [...], "permissions": [...] }
```

**Negative checks:**
```bash
# Missing tenant header → fail-closed 4xx (NOT 200).
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$GW/user-management/v1/auth/login" \
  -H "content-type: application/json" \
  -d '{"email":"admin@demo-org.test","password":"demo-admin-pw"}'   # Expected: 400

# Tenant-A token presented with tenant-B header → defence-in-depth 403.
curl -s -o /dev/null -w "%{http_code}\n" "$GW/user-management/v1/auth/me" \
  -H "x-tenant-id: $TB" -H "authorization: Bearer $TOKEN_A"          # Expected: 403
```

---

## 4. Expense create → submit → approval decide chain  (FV2 expense + shared approval engine)

```bash
# 4a. Create a report (OPEN).
RID=$(curl -s -X POST "$GW/expense/v1/reports" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"name":"E2E Trip","currency":"USD"}' | jq -r .data.id)
echo "report: $RID"      # Expected: a UUID

# 4b. Attach a line item (non-zero total).
curl -s -X POST "$GW/expense/v1/reports/$RID/expenses" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"amount":4200,"currency":"USD","merchant":"E2E Diner","description":"dinner"}' | jq -c .data

# 4c. Submit: OPEN → APPROVALS (emits expense.submitted, staged in event_outbox).
curl -s -X POST "$GW/expense/v1/reports/$RID/submit" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"note":"please review"}' | jq -c .data
# Expected: 200, status is NOT "open" (serialized DTO statuses are lowercase: open|approvals|approved).
```

> **Seeded-tenant nuance (read this):** the demo tenants' default expense policy L1 is
> `source: manager`, and **no `approval_hierarchy` edges are seeded**, so the engine resolves an empty
> manager level and **auto-completes** the chain (documented "unconfigured org chart" behaviour —
> `apps/cli/src/seeders/0004_approval_policies.ts`). So after submit the report typically lands directly
> in **APPROVED** with **no pending slot**. To exercise a real human decision, first seed an
> `approval_hierarchy` edge (manager → submitter) or switch the L1 level to `source: user`/`group`.

```bash
# 4d. Does the approver have a pending slot? (empty when the chain auto-completed)
curl -s "$GW/expense/v1/reports/approvals/pending" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq '.data'

# 4e. If (and only if) a slot exists, record the canonical engine-backed decision.
curl -s -X POST "$GW/expense/v1/reports/$RID/decisions" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"decision":"approved","comment":"looks good"}' | jq -c .data

# 4f. Read the report back — final state.
curl -s "$GW/expense/v1/reports/$RID" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq '.data.status'
# Expected: "approved" (or "approvals" if you configured a real approver and have not decided yet).
```

### Assert the side effects (event → consumer → notification + audit)

```bash
# Outbox: the submit/approve events were staged and the relay drained them (status 'published').
docker compose -f docker-compose.all.yml exec -T postgres psql -U aegis_owner -d aegis -c \
  "SELECT topic, status, attempts FROM event_outbox WHERE tenant_id='$TA' ORDER BY created_at DESC LIMIT 5;"
# Expected: rows with status='published' (NOT lingering 'pending', NOT 'failed').

# Notification fan-out: the notification-worker wrote an in-app notification for the approver.
curl -s "$GW/notification/v1/notifications?page=1&pageSize=20" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq '.data | length'
# Expected: >= 1 (an approval-requested / status-change notification).

# Audit: a hash-chained row was appended for the login + the state transitions.
docker compose -f docker-compose.all.yml exec -T postgres psql -U aegis_owner -d aegis -c \
  "SELECT action, outcome FROM audit_log WHERE tenant_id='$TA' ORDER BY created_at DESC LIMIT 5;"
```

---

## 5. Cross-tenant RLS isolation  (FLOW-024 / FV2 multi-tenancy)

```bash
TOKEN_B=$(curl -s -X POST "$GW/user-management/v1/auth/login" \
  -H "content-type: application/json" -H "x-tenant-id: $TB" \
  -d '{"email":"admin@demo-org-b.test","password":"demo-admin-pw-b"}' | jq -r .token)

# Tenant B tries to read tenant A's report ($RID from §4) → RLS makes the row invisible → 404.
curl -s -o /dev/null -w "%{http_code}\n" "$GW/expense/v1/reports/$RID" \
  -H "x-tenant-id: $TB" -H "authorization: Bearer $TOKEN_B"     # Expected: 404 (NOT 200, NOT 403)

# Tenant A can still read its own report.
curl -s -o /dev/null -w "%{http_code}\n" "$GW/expense/v1/reports/$RID" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A"     # Expected: 200

# Lists never leak across tenants: B's list must not contain A's report name.
curl -s "$GW/expense/v1/reports?page=1&pageSize=100" \
  -H "x-tenant-id: $TB" -H "authorization: Bearer $TOKEN_B" | jq '[.data[].name]'
```

**Why 404 not 403:** the app runs under the non-owner `aegis_app` role with `FORCE ROW LEVEL
SECURITY`; the per-transaction `app.current_tenant` session var scopes every query, so the foreign row
simply does not exist for tenant B — the service then returns its standard not-found.

---

## 6. Payroll Separation-of-Duties  (FV2 payroll SoD — W3 `excludeRequester`)

The seeded pay-run approval policy has `excludeRequester: true`: whoever queues a pay run can **never**
approve it. With a single admin (who both creates and would approve), the approver pool excludes the
requester, so the requester's own approve attempt must be rejected by the engine.

```bash
# 6a. Create a pay run (as admin = the requester).
PRID=$(curl -s -X POST "$GW/payroll/v1/pay-runs" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"periodStart":"2026-06-01","periodEnd":"2026-06-30","payDate":"2026-07-05"}' | jq -r '.id // .data.id')
echo "pay run: $PRID"

# 6b. Calculate it (→ Calculated).
curl -s -X POST "$GW/payroll/v1/pay-runs/$PRID/calculate" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq -c .

# 6c. The REQUESTER attempts to approve → SoD denies it (4xx; the requester is excluded).
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$GW/payroll/v1/pay-runs/$PRID/decisions" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"decision":"approved"}'
# Expected: 403 (hard in-service SoD guard: "the approver must differ from the principal who
#           created/edited the pay-run"). A SEPARATE approver user must decide.
```

> To complete the run, register a second user in tenant A, grant them `PayRunApprove` (via
> `POST /user-management/v1/users/:userId/role`), log in as them, and call `/decisions` — then the run
> advances to **Approved** and emits `PayRunApproved`.

---

## 7. Invoice duplicate detection / dedup  (FV2 invoice dedup — migration 0017)

Duplicate detection is **flag-not-reject**: a re-post of the same signature (`vendor + invoice_number +
amount + currency`) is still **accepted (201)** but the new invoice is marked **`duplicate`** and linked
to the live winner via an `invoice_duplicates` row — the partial-unique `invoices_dup_signature_live_uq`
index (0017) guarantees only ONE *live* (non-duplicate) invoice may hold a signature (the no-double-pay
guarantee). It is **tenant-scoped**, so the same number under another tenant is independent.

```bash
# 7a. Create an invoice → status 'received'/'pending_review' (the live winner).
curl -s -X POST "$GW/invoice/v1/invoices" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"vendorName":"Acme","invoiceNumber":"INV-1001","invoiceDate":"2026-06-01","amountMinor":50000,"currency":"USD"}' | jq '.data.status'
# Expected: 201, status NOT "duplicate" (e.g. "pending_review").

# 7b. Re-post the SAME signature → accepted (201) but FLAGGED as a duplicate.
curl -s -X POST "$GW/invoice/v1/invoices" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"vendorName":"Acme","invoiceNumber":"INV-1001","invoiceDate":"2026-06-01","amountMinor":50000,"currency":"USD"}' | jq '.data.status'
# Expected: 201, status == "duplicate".

# 7c. Confirm exactly ONE live (non-duplicate) invoice holds the signature, plus the duplicate link row.
docker compose -f docker-compose.all.yml exec -T postgres psql -U aegis_owner -d aegis -c \
  "SELECT status, COUNT(*) FROM invoices WHERE tenant_id='$TA' AND invoice_number='INV-1001' GROUP BY status;"
# Expected: one row status<>'duplicate' (the winner) + one row status='duplicate'.

# 7d. The SAME number under tenant B is a NEW live invoice (dedup is tenant-scoped).
curl -s -X POST "$GW/invoice/v1/invoices" \
  -H "content-type: application/json" -H "x-tenant-id: $TB" -H "authorization: Bearer $TOKEN_B" \
  -d '{"vendorName":"Acme","invoiceNumber":"INV-1001","invoiceDate":"2026-06-01","amountMinor":50000,"currency":"USD"}' | jq '.data.status'
# Expected: 201, status NOT "duplicate".
```

---

## 8. Audit hash-chain verify  (FLOW-093 / FV2 audit)

There is **no public HTTP audit-verify endpoint** — verification is the internal
`AuditLogger.verifyChain` (`libs/audit/src/audit-logger.ts`). Re-walk the chain directly in Postgres
and assert continuity (`prev_hash` of row N == `hash` of row N-1, first `prev_hash` == `GENESIS`):

```bash
docker compose -f docker-compose.all.yml exec -T postgres psql -U aegis_owner -d aegis -c "
  WITH ordered AS (
    SELECT id, prev_hash, hash,
           LAG(hash) OVER (ORDER BY created_at, id) AS prior_hash,
           ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
      FROM audit_log WHERE tenant_id='$TA')
  SELECT COUNT(*) AS rows,
         COUNT(*) FILTER (WHERE rn=1 AND prev_hash <> 'GENESIS') AS bad_genesis,
         COUNT(*) FILTER (WHERE rn>1 AND prev_hash IS DISTINCT FROM prior_hash) AS broken_links
    FROM ordered;"
# Expected: rows >= 1, bad_genesis = 0, broken_links = 0.
```

The cryptographic re-hash (recomputing `sha256(prev|canonical)` for every row and comparing to the
stored `hash`) is automated in the harness's `audit-chain.e2e.spec.ts` (§10), which replicates
`libs/audit/src/hash.ts` exactly.

---

## 9. Reading logs & the DLQ

```bash
# Tail a service (follow the correlation id you sent / got back).
docker compose -f docker-compose.all.yml logs -f gateway expense workflow-worker notification-worker

# Filter by a correlation id across all services:
docker compose -f docker-compose.all.yml logs --no-color | grep "<your-x-correlation-id>"
```

**The outbox IS the DLQ.** A staged event lives in `event_outbox` with `status='pending'`; the relay
(`OutboxRelay`, `libs/events/src/outbox.ts`) drains it `FOR UPDATE SKIP LOCKED`, sets `status='published'`
on success, and increments `attempts` on failure. After `OUTBOX_RELAY_MAX_ATTEMPTS` (default **5**) a
row is **parked as `status='failed'`** — that parked set is the dead-letter queue.

```bash
# Healthy: nothing stuck pending, nothing parked failed.
docker compose -f docker-compose.all.yml exec -T postgres psql -U aegis_owner -d aegis -c \
  "SELECT status, COUNT(*) FROM event_outbox GROUP BY status;"
# Expected: mostly 'published'; transient 'pending' that clears on the next poll; '0' 'failed'.

# Inspect the DLQ (parked rows) with their last error:
docker compose -f docker-compose.all.yml exec -T postgres psql -U aegis_owner -d aegis -c \
  "SELECT id, topic, attempts, last_error FROM event_outbox WHERE status='failed' ORDER BY created_at DESC;"

# Re-drive the DLQ after a fix (reset a parked row to pending; the relay re-attempts on its next poll):
docker compose -f docker-compose.all.yml exec -T postgres psql -U aegis_owner -d aegis -c \
  "UPDATE event_outbox SET status='pending', attempts=0, last_error=NULL WHERE status='failed';"
```

> **Producer-on-every-pod sanity:** with `KAFKA_BROKERS=kafka:9092` set in every `.env`,
> `initEventBus()` activates a real `KafkaBus` on **every** api pod (not just the workers), and the
> producer pods (expense/payroll/invoice) each run the outbox relay in-process (the
> `OUTBOX_RELAY_ENABLED` default is `true`; `SKIP LOCKED` makes concurrent relays safe). Only the
> `workflow-worker` / `notification-worker` roles additionally `registerConsumers()` + `bus.start()`.
> If submit events never reach the workers, confirm (a) the two `*-worker` containers are up, and
> (b) `event_outbox` rows reach `published` (relay draining) rather than lingering `pending`.

---

## 10. Automated harness (same flows, asserted)

The gated jest suite lives in [`apps/e2e-tests/live/`](../../apps/e2e-tests/live). It is **inert**
under the normal mocked `npx jest` (every block is `describe.skip` until `E2E_BASE_URL` is set), so it
never opens a socket during unit-test runs. Point it at the running gateway to execute it:

```bash
# Auth + expense approval chain + RLS isolation (HTTP-only):
E2E_BASE_URL=http://localhost:4000 npx jest apps/e2e-tests/live

# Also run the audit hash-chain re-walk (needs a direct Postgres DSN, e.g. the owner URL):
E2E_BASE_URL=http://localhost:4000 \
E2E_DATABASE_URL=postgres://aegis_owner:aegis_local@localhost:5432/aegis \
  npx jest apps/e2e-tests/live
```

**Expected** — with the env set: the `live:` suites run green. Without it (plain `npx jest`): the same
suites report **skipped** (and the rest of the monorepo's mocked tests pass unchanged).

---

## 11. Teardown

```bash
# Stop + remove containers + network, KEEP volumes (fast restart, data retained):
docker compose -f docker-compose.all.yml down

# Full wipe (also drop the Postgres + Kafka volumes — next dev-up re-seeds from scratch):
docker compose -f docker-compose.all.yml down -v
```

> After a `down -v`, the first `dev-up.sh` re-runs `scripts/db-init/01-init.sql` (recreates the
> `aegis_app` role) and the migration one-shot (re-seeds both demo tenants), so the fixtures in §2 are
> always present on a clean bring-up.
