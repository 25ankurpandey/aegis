# Aegis demo scripts — run one command, *see* a whole flow

Narrated, executable `curl` walkthroughs of every flow-catalogue suite (A–G), run against the
**running stack** (gateway `http://localhost:4000`). Each script prints a `STEP → EXPECT → PASS/FAIL`
banner per action (the terminal mirror of the flow-catalogue caption track), shows the actual
request + response, and asserts the expected status — so a reviewer (or an agent) runs one script and
watches the flow happen end to end.

These mirror the verified recipes in [`../../docs/testing/CURL_EXAMPLES.md`](../../docs/testing/CURL_EXAMPLES.md)
and the flows in [`../../docs/testing/flow-catalogue.md`](../../docs/testing/flow-catalogue.md).

## Prerequisites

1. A running stack: **`bash scripts/setup.sh`** (Postgres + RLS, Redis, Kafka, all 9 services + workers).
   Every demo gates on `GET /health` and points you back here if the stack is down.
2. `curl` and `jq` on `PATH` (macOS: `brew install jq`).

The scripts use the seeded demo credentials printed by `setup.sh`
(`admin@demo-org.test` / `demo-admin-pw`, tenant `00000000-0000-4000-8000-000000000001`; a second
tenant exists for cross-tenant isolation). Override any default via env (`GW`, `TENANT_A`,
`ADMIN_A_EMAIL`, …) — see the top of `lib.sh`.

## Run

```bash
bash scripts/demo/run-all.sh            # every suite, in order, with a roll-up pass/fail summary
bash scripts/demo/03-expense.sh         # or one suite at a time
```

| Script | Suite | Flows |
|---|---|---|
| `00-platform-tenancy.sh` | A — Platform & tenancy | health/readiness, tenant onboarding result, fail-closed tenant context |
| `01-identity.sh` | B — Identity & sessions | register, login (JWT), `/me`; wrong-pw / tampered-token / cross-tenant negatives |
| `02-access-control.sh` | C — Access-control core | runtime role create + assign (PAP), allowed vs denied decision, cross-tenant isolation **must-fail** |
| `03-expense.sh` | D — Expense lifecycle | create → item → submit → approval-engine decision → ERP-push trigger |
| `04-invoice.sh` | E — Invoice lifecycle | create → duplicate detection (flag, original intact) → submit → approve |
| `05-workflow-approvals.sh` | F — Workflow & approvals | rule fires on matching facts / no-match on small; multi-level + delegated notes |
| `06-payroll.sh` | G — Payroll | employee onboard (encrypted PII) → draft → calculate → maker-checker SoD denial → disburse gate |

## Record terminal casts

```bash
bash scripts/demo/record-all.sh
```

Wraps each suite in `asciinema rec` → one `.cast` per suite under
[`../../docs/recordings/`](../../docs/recordings/). If `asciinema` is not installed, it prints the
macOS built-in screen-recording instructions (`Cmd+Shift+5`) instead.

## Notes / honest scope

- Everything goes through the **gateway**; each service re-enforces auth via its own PEP (defense in
  depth). Headers: `x-tenant-id` (required, fail-closed), `x-correlation-id` (echoed), `authorization`.
- A few catalogue behaviors are **asynchronous side effects** (connector ERP push, notification
  fan-out, the audit hash-chain, the double-entry ledger). The demos exercise the synchronous trigger
  and surface the resulting state; the row-level side-effect assertions live in
  [`../../docs/testing/LIVE_E2E_RUNBOOK.md`](../../docs/testing/LIVE_E2E_RUNBOOK.md) (direct `psql`).
- The seeded demo tenant auto-completes the expense approval chain (no `approval_hierarchy` edge is
  seeded), so `03-expense.sh` handles both the auto-complete and the real-approver paths; payroll's
  maker-checker denial is exercised directly because `excludeRequester: true` is seeded.
