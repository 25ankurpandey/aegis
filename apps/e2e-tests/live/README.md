# Live E2E harness (`apps/e2e-tests/live/`)

HTTP-driven end-to-end specs that run the `E2E`-tier flows from
[`docs/testing/FLOWS_v2.md`](../../../docs/testing/FLOWS_v2.md) against a **running** dockerized Aegis
stack, through the public **gateway** (`:4000`), exactly as an external client would.

Companion to the manual [`LIVE_E2E_RUNBOOK.md`](../../../docs/testing/LIVE_E2E_RUNBOOK.md) — same
flows, asserted programmatically.

## The gate (why this never breaks the normal test run)

Every block uses `describeE2E` (`lib/client.ts`), which is `describe` only when **`E2E_BASE_URL`** is
set and `describe.skip` otherwise. So under a plain `npx jest` (mocked unit-test mode) the whole suite
is **collected but skipped** — no `fetch`, no socket, no DB. The root `jest.config.js` globs these
`*.e2e.spec.ts` files (its `roots` include `apps/`), which is exactly the integration point: they ride
along the normal run, inert, until you point them at a live stack.

`audit-chain.e2e.spec.ts` is **double-gated**: it also needs **`E2E_DATABASE_URL`** (a direct Postgres
DSN), because there is no public audit-verify endpoint — it re-walks the hash chain in SQL, replicating
`libs/audit/src/hash.ts`. `pg` is `require`d lazily inside the gated block so it never loads otherwise.

## Run it

```bash
# 1) Bring the stack up + migrate/seed (see the runbook):
bash scripts/dev-up.sh

# 2) HTTP flows (auth, expense approval chain, RLS isolation across tenants A & B):
E2E_BASE_URL=http://localhost:4000 npx jest apps/e2e-tests/live

# 3) Add the audit hash-chain re-walk:
E2E_BASE_URL=http://localhost:4000 \
E2E_DATABASE_URL=postgres://aegis_owner:aegis_local@localhost:5432/aegis \
  npx jest apps/e2e-tests/live
```

Without any env: `npx jest apps/e2e-tests/live` → all suites **skipped** (0 executed).

## Files

| File | Flow | Gate |
|---|---|---|
| `lib/client.ts` | fetch wrapper, `describeE2E`, seeded fixtures, `login()` | — |
| `auth.e2e.spec.ts` | register / login / JWT / fail-closed header / tenant-mismatch 403 | `E2E_BASE_URL` |
| `expense-approval.e2e.spec.ts` | create → attach → submit → decide chain | `E2E_BASE_URL` |
| `rls-isolation.e2e.spec.ts` | cross-tenant RLS (A vs B): foreign rows 404, lists never leak | `E2E_BASE_URL` |
| `audit-chain.e2e.spec.ts` | tamper-evident audit hash-chain re-walk | `E2E_BASE_URL` + `E2E_DATABASE_URL` |

## Fixtures (seeded by `apps/cli/src/seeders`)

| Tenant | `x-tenant-id` | admin email / password |
|---|---|---|
| A | `00000000-0000-4000-8000-000000000001` | `admin@demo-org.test` / `demo-admin-pw` |
| B | `00000000-0000-4000-8000-000000000002` | `admin@demo-org-b.test` / `demo-admin-pw-b` |

Tenant B (`0005_demo_tenant_b.ts`) exists so cross-tenant RLS isolation is push-button.
