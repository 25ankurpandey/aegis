# Aegis — curl examples (hit every flow against the gateway)

Copy-paste these, in order, against a running stack (`bash scripts/setup.sh` first). Everything goes
through the **gateway on `:4000`** — the single entry point. Each downstream service re-enforces auth
via its own PEP (defense in depth), so the gateway only routes.

These mirror the proven flows in [`LIVE_E2E_RUNBOOK.md`](./LIVE_E2E_RUNBOOK.md); that runbook adds the
side-effect assertions (event outbox, notifications, audit hash-chain, DLQ) via direct `psql`.

## Conventions

Every request carries:

- `x-tenant-id: <tenant UUID>` — **required, fail-closed**. The context middleware rejects a missing
  tenant with a 4xx; it never defaults.
- `x-correlation-id: <any id>` — optional inbound (the gateway mints one if absent) but **echoed back**,
  so set your own to grep logs by it.
- `authorization: Bearer <jwt>` — on every authenticated route (everything except
  `/user-management/v1/auth/register` and `/user-management/v1/auth/login`).

Route prefix = first path segment → service (`/expense/...` → expense). Public API version prefix is
`/v1`. Lists return `{ data, meta }`; single resources return `{ data }`.

Needs `curl` and `jq`.

### Convenience env

```bash
export GW=http://localhost:4000
export TA=00000000-0000-4000-8000-000000000001     # Demo Org (tenant A)
export TB=00000000-0000-4000-8000-000000000002     # Demo Org B (tenant B)
export CID=demo-$(date +%s)                          # your correlation id for this session
```

The seeded admin (`admin@demo-org.test` / `demo-admin-pw`) holds **every permission**, so one login
drives all flows below.

---

## 0. Health (no auth, no tenant — `/health` bypasses all middleware)

```bash
curl -s "$GW/health" | jq                      # gateway
for p in 4001 4002 4003 4004 4005 4006 4007; do
  echo "port $p:"; curl -s "http://localhost:$p/health" | jq -c .
done
# Expected: each → {"service":"...","status":"ok","uptime":...}

# Deep check (DB + cache) on any service:
curl -s "http://localhost:4002/health?details=true" | jq
# Expected: {"service":"expense","status":"ok","db":true,"cache":true}
```

---

## 1. Auth — register → login (save JWT) → me

```bash
# 1a. Register a fresh user in tenant A (tenant comes from the HEADER, not the body).
curl -s -X POST "$GW/user-management/v1/auth/register" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "x-correlation-id: $CID" \
  -d '{"email":"e2e-user@demo-org.test","password":"e2e-password-123","firstName":"E2E","lastName":"User"}' | jq
# Expected: 201 { "id": "...", "email": "e2e-user@demo-org.test" }

# 1b. Log in the seeded admin → JWT. Save it to a shell var (Postman saves it to {{token}}).
export TOKEN_A=$(curl -s -X POST "$GW/user-management/v1/auth/login" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "x-correlation-id: $CID" \
  -d '{"email":"admin@demo-org.test","password":"demo-admin-pw"}' | jq -r .token)
echo "${TOKEN_A:0:24}..."   # Expected: a 3-part JWT (header.payload.signature)

# 1c. The JWT is accepted by an authenticated route.
curl -s "$GW/user-management/v1/auth/me" \
  -H "x-tenant-id: $TA" -H "x-correlation-id: $CID" -H "authorization: Bearer $TOKEN_A" | jq
# Expected: 200 { "id":"...", "email":"admin@demo-org.test", "roles":[...], "permissions":[...] }
```

**Negative checks (prove fail-closed + defense-in-depth):**

```bash
# Missing tenant header → fail-closed 4xx (NOT 200).
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$GW/user-management/v1/auth/login" \
  -H "content-type: application/json" \
  -d '{"email":"admin@demo-org.test","password":"demo-admin-pw"}'      # Expected: 400

# Tenant-A token presented with the tenant-B header → 403 at the downstream PEP.
curl -s -o /dev/null -w "%{http_code}\n" "$GW/user-management/v1/auth/me" \
  -H "x-tenant-id: $TB" -H "authorization: Bearer $TOKEN_A"            # Expected: 403
```

---

## 2. Expense — create → attach item → submit → decide → read back

```bash
# 2a. Create a report (OPEN).
export RID=$(curl -s -X POST "$GW/expense/v1/reports" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"name":"E2E Trip","currency":"USD"}' | jq -r .data.id)
echo "report: $RID"          # Expected: a UUID

# 2b. Attach a line item (amount in integer minor units; non-zero total).
curl -s -X POST "$GW/expense/v1/reports/$RID/expenses" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"amount":4200,"currency":"USD","merchant":"E2E Diner","description":"dinner"}' | jq -c .data

# 2c. Submit: OPEN → APPROVALS (emits expense.submitted into the event outbox).
curl -s -X POST "$GW/expense/v1/reports/$RID/submit" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"note":"please review"}' | jq -c .data
# Expected: 200. Serialized statuses are lowercase: open|approvals|approved|rejected|reimbursed.
```

> **Seeded-tenant nuance:** the demo tenant's default expense policy L1 is `source: manager`, and no
> `approval_hierarchy` edges are seeded, so the engine resolves an empty manager level and
> **auto-completes** the chain. After submit the report typically lands directly in **APPROVED** with
> **no pending slot**. To exercise a real human decision, seed an `approval_hierarchy` edge
> (manager → submitter) or switch L1 to `source: user`/`group`
> (`apps/cli/src/seeders/0004_approval_policies.ts`).

```bash
# 2d. List the current user's pending approval slots (empty when the chain auto-completed).
curl -s "$GW/expense/v1/reports/approvals/pending" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq '.data'

# 2e. If (and only if) a slot exists, record the canonical engine-backed decision.
curl -s -X POST "$GW/expense/v1/reports/$RID/decisions" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"decision":"approved","comment":"looks good"}' | jq -c .data

# 2f. Read the report back — final state.
curl -s "$GW/expense/v1/reports/$RID" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq '.data.status'
# Expected: "approved" (or "approvals" if you configured a real approver and have not decided yet).
```

---

## 3. Invoice — create → submit → decide (approve)

```bash
# 3a. Create an invoice → the live winner (status e.g. "pending_review", NOT "duplicate").
export IID=$(curl -s -X POST "$GW/invoice/v1/invoices" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"vendorName":"Acme","invoiceNumber":"INV-1001","invoiceDate":"2026-06-01","amountMinor":50000,"currency":"USD"}' \
  | jq -r .data.id)
echo "invoice: $IID"

# 3b. Submit it for approval.
curl -s -X POST "$GW/invoice/v1/invoices/$IID/submit" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq -c .data

# 3c. Record the engine-backed approval decision.
curl -s -X POST "$GW/invoice/v1/invoices/$IID/decisions" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"decision":"approved","comment":"ok to pay"}' | jq -c .data

# 3d. Read it back.
curl -s "$GW/invoice/v1/invoices/$IID" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq '.data.status'

# 3e. (bonus) Duplicate detection is FLAG-not-reject: re-posting the SAME
#     vendor+number+amount+currency is still accepted (201) but flagged "duplicate".
curl -s -X POST "$GW/invoice/v1/invoices" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"vendorName":"Acme","invoiceNumber":"INV-1001","invoiceDate":"2026-06-01","amountMinor":50000,"currency":"USD"}' \
  | jq '.data.status'
# Expected: 201, status == "duplicate".
```

---

## 4. Payroll — create → calculate → approve → disburse

> **Separation of Duties:** the seeded pay-run policy has `excludeRequester: true` — whoever queues a
> run can never approve it. With the single seeded admin (who both creates and would approve), the
> requester's own approve attempt is **denied (403)**. To complete the chain end-to-end, register a
> second user in tenant A, grant them `PayRunApprove`, log in as them, and call `/decisions`. The
> recipe below shows the full lifecycle; step 4c is the documented SoD denial.

```bash
# 4a. Create a pay run (as admin = the requester).
export PRID=$(curl -s -X POST "$GW/payroll/v1/pay-runs" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"periodStart":"2026-06-01","periodEnd":"2026-06-30","payDate":"2026-07-05"}' | jq -r '.id // .data.id')
echo "pay run: $PRID"

# 4b. Calculate it (→ Calculated).
curl -s -X POST "$GW/payroll/v1/pay-runs/$PRID/calculate" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq -c .

# 4c. The REQUESTER attempts to approve → SoD denies it (the requester is excluded from the pool).
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$GW/payroll/v1/pay-runs/$PRID/decisions" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"decision":"approved"}'
# Expected: 403 — a SEPARATE approver must decide.

# 4d. After a separate approver advances the run to Approved, disburse it.
#     Disburse is a money write: it requires an Idempotency-Key header (replays are no-ops).
curl -s -X POST "$GW/payroll/v1/pay-runs/$PRID/disburse" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -H "Idempotency-Key: disburse-$PRID-001" | jq -c .
# Expected (once Approved): 200; re-issuing with the SAME key returns the same result without re-paying.
```

---

## 5. Tenant config + feature flags — get / set

```bash
# 5a. List all tenant config (gated by tenant.view).
curl -s "$GW/user-management/v1/tenant/config" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq

# 5b. Set a config key (gated by tenant.manage; the path is the key, body carries { value }).
curl -s -X PUT "$GW/user-management/v1/tenant/config/default_currency" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"value":"USD"}' | jq

# 5c. List feature flags.
curl -s "$GW/user-management/v1/tenant/features" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq

# 5d. Toggle a feature flag on (path is the flag, body carries { enabled }).
curl -s -X PUT "$GW/user-management/v1/tenant/features/spatial_expense_viz" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{"enabled":true}' | jq
```

---

## 6. Reporting — define → run (async) → poll

Report runs are **asynchronous**: the POST returns `202 { runId }` with a `Location` header; you poll
the run for `status` + `artifact_url`. No definition is seeded, so create one first.

```bash
# 6a. Create a report definition (the spec is validated structurally as data, never raw SQL).
export DEFID=$(curl -s -X POST "$GW/reporting/v1/report-definitions" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d '{
        "name":"Expense by month",
        "spec":{
          "measures":[{"name":"total","agg":"sum","field":"amount"}],
          "dimensions":[{"name":"month","field":"incurred_on","grain":"month"}],
          "filters":[],
          "source":"expense_report"
        }
      }' | jq -r .data.id)
echo "definition: $DEFID"

# 6b. Enqueue a run → 202 + { runId }.
export RUNID=$(curl -s -X POST "$GW/reporting/v1/report-runs" \
  -H "content-type: application/json" -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" \
  -d "{\"definitionId\":\"$DEFID\",\"params\":{}}" | jq -r .data.runId)
echo "run: $RUNID"

# 6c. Poll the run until it finishes (status → succeeded, with an artifact_url).
curl -s "$GW/reporting/v1/report-runs/$RUNID" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A" | jq '.data | {status, artifact_url}'
```

---

## 7. Cross-tenant RLS isolation (bonus — prove tenant data never leaks)

```bash
export TOKEN_B=$(curl -s -X POST "$GW/user-management/v1/auth/login" \
  -H "content-type: application/json" -H "x-tenant-id: $TB" \
  -d '{"email":"admin@demo-org-b.test","password":"demo-admin-pw-b"}' | jq -r .token)

# Tenant B tries to read tenant A's report ($RID from §2) → RLS makes the row invisible → 404.
curl -s -o /dev/null -w "%{http_code}\n" "$GW/expense/v1/reports/$RID" \
  -H "x-tenant-id: $TB" -H "authorization: Bearer $TOKEN_B"     # Expected: 404 (NOT 200, NOT 403)

# Tenant A still reads its own report.
curl -s -o /dev/null -w "%{http_code}\n" "$GW/expense/v1/reports/$RID" \
  -H "x-tenant-id: $TA" -H "authorization: Bearer $TOKEN_A"     # Expected: 200
```

**Why 404 not 403:** the app runs under the non-owner `aegis_app` role with `FORCE ROW LEVEL
SECURITY`; the per-transaction `app.current_tenant` session var scopes every query, so the foreign row
simply does not exist for tenant B.

---

## Notes

- **Order matters within a flow** (create before submit before decide); flows are otherwise independent.
- The seeded admin has all permissions; to see RBAC/ABAC denials, register a lower-privilege user and
  re-run a write.
- Trace anything end-to-end by the `x-correlation-id` you sent:
  `docker compose -f docker-compose.all.yml logs --no-color | grep "$CID"`.
- For the full side-effect assertions (event_outbox draining, notification fan-out, audit hash-chain,
  the DLQ), see [`LIVE_E2E_RUNBOOK.md`](./LIVE_E2E_RUNBOOK.md).
