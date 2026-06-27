# Aegis — Testing & Verification Plan

> **Status:** living plan. Unit/integration suites, an in-process cross-service harness, a gated
> live HTTP harness, and the flow catalogue now exist. As features land, tick the boxes,
> fill in the flow ids, and keep this file consistent with
> [`SPEC.md`](SPEC.md) (single source of truth, incl. §10 Amendments — 2026-06-26) and
> [`AGENTS.md`](AGENTS.md). Where this plan and `SPEC.md` ever disagree, **`SPEC.md` wins** —
> fix this file.
>
> **Companion docs (cross-linked):**
> - [`docs/testing/flow-catalogue.md`](docs/testing/flow-catalogue.md) — the per-flow catalogue (one entry per end-to-end flow across all services).
> - [`docs/testing/flow-recording.md`](docs/testing/flow-recording.md) — the screen-capture + annotation plan for recorded flow walkthroughs.
> - [`BUGLOG.md`](BUGLOG.md) — append-only issue log the scheduled bug-hunting agents write to.
> - Service docs: [`docs/services/`](docs/services/) — per-service flows referenced by the catalogue.
> - Model/architecture references: [`docs/03-access-control-model.md`](docs/03-access-control-model.md),
>   [`docs/04-multi-tenancy.md`](docs/04-multi-tenancy.md),
>   [`docs/05-authn-authz-flow.md`](docs/05-authn-authz-flow.md),
>   [`docs/06-service-to-service.md`](docs/06-service-to-service.md),
>   [`docs/10-auditability-and-compliance.md`](docs/10-auditability-and-compliance.md).

---

## 1. Testing philosophy

Aegis is an **access-control system first** and a set of business services second. The thing we are
really proving is not "expense reports can be created" but **"the right principal, in the right
tenant, with the right role, can do exactly what they are allowed to and *nothing else* — and the
database itself refuses to leak across tenants even when the application is wrong."** Every test
strategy below is biased toward that claim.

Principles:

1. **Fail-closed is the default assertion.** For authz and tenancy, the interesting test is the
   **deny** case. A flow is not "covered" until both its **allow** path and its **deny** path are
   asserted. A missing guard must produce a `403`, never a silent `200`.
2. **Defense-in-depth is tested in depth.** Tenant isolation is enforced twice (compiled query
   predicates **and** PostgreSQL RLS). We test both layers *independently*: app-layer tests with RLS
   present, plus a dedicated **RLS backstop** suite that proves isolation holds even if the
   application forgets its `WHERE tenant_id = …`.
3. **The database is a witness.** Functional assertions on HTTP responses are necessary but not
   sufficient. For every state-changing flow we also assert **DB state** (the rows that should/should
   not exist, their column values, and audit/ledger side-effects). See §7.
4. **Determinism over flakiness.** One **seeded multi-tenant fixture** (§6.1), fixed UUIDs, fixed
   clock, fixed PRNG seed. No test depends on wall-clock time, ordering of parallel runs, or network
   to real third parties — ERP is exercised through **mock `@aegis/connectors`** (LedgerOne / Finovo
   / AcctBridge), never real accounting systems.
5. **Test the contract, not the implementation.** Assert against DTOs, the error envelope
   `{ errors: [{ code, type, message, details, traceId }] }`, permission verdicts, and audit
   records — the stable surface — so refactors of internals don't churn tests.
6. **Security and integrity are non-negotiable gates.** The security/authz, tenant-isolation, and
   audit hash-chain suites are **release-blocking**: a red there blocks promotion regardless of
   feature coverage.
7. **Tests are written against the spec, not the code.** This document and the flow catalogue are
   authored first; tests encode the *intended* behaviour so that a wrong implementation fails.

---

## 2. Test levels

| Level | Scope | Runner | Where it lives | Speed / when |
|-------|-------|--------|----------------|--------------|
| **L0 Static** | Types, lint, forbidden-name grep, dead-route scan | `tsc --noEmit`, ESLint, custom grep | repo root + `nx affected` | every commit / pre-push |
| **L1 Unit** | Pure logic in isolation — PDP `decide()`, ABAC condition eval, state machines, hash-chain link fn, masking, idempotency-key derivation | **Jest (+ ts-jest)** | `libs/**/*.spec.ts`, `apps/<svc>/src/**/*.spec.ts` | every commit |
| **L2 Integration (in-service)** | One service + a **real PostgreSQL** (RLS on) + stubbed siblings; HTTP in via **supertest**; PEP→PDP→repo→DB end to end | Jest + supertest + ephemeral Postgres | `apps/<svc>/test/integration/**` | per-service CI |
| **L3 Cross-service E2E** | Multiple services wired through the **gateway**, internal-JWT + context propagation, `@aegis/events` bus, mock connectors; a whole business flow | Jest + supertest against a docker-compose'd stack | `test/e2e/**` | nightly + pre-release |
| **L4 Data-integrity** | DB-state truth after a flow: ledger balances, append-only invariants, audit hash-chain continuity, idempotency dedupe, outbox delivery | Jest asserting on SQL queries | `test/integrity/**` | nightly |
| **L5 Security / AuthZ** | Allow+deny decision matrix, token validation (exp/aud/sig/revocation), privilege escalation attempts, IDOR | Jest + supertest, adversarial inputs | `test/security/**` | every CI + nightly (**release-blocking**) |
| **L6 Tenant-isolation** | Cross-tenant leak attempts at API and at the SQL layer; RLS backstop with the app's non-owner role | Jest + raw `pg` as the app role | `test/tenancy/**` | every CI + nightly (**release-blocking**) |
| **L7 Regression** | Every fixed `BUG-NNNN` gets a locked-in test; full-suite re-run | Jest (tagged `@regression`) | `test/regression/**` | every CI |

`nx affected -t test` runs L0–L2 on the changed graph; the nightly bug-hunting agent (§9) runs the
full L3–L6 matrix against a freshly seeded stack.

---

## 3. WHAT to test — by area

Each area below is a checklist. `[ ]` = planned. Each line maps to one or more entries in
[`docs/testing/flow-catalogue.md`](docs/testing/flow-catalogue.md) (flow id `FLOW-<area>-NN`).

### 3.1 Authentication (`gateway` + `user-management` IdP) — `FLOW-AUTHN-*`
- [ ] Issue token → valid **RS256/ES256** JWT with `sub`, `tenant_id`, `roles`, per-service `aud`, `exp`.
- [ ] Gateway accepts a well-formed token and routes; **each service re-validates** via JWKS (defense-in-depth).
- [ ] Reject: bad signature, expired `exp`, wrong `aud` (token for `expense` presented to `payroll`), missing token, malformed bearer.
- [ ] **Session revocation row**: login creates a `sessions` row, admin revocation marks it revoked; per-request token introspection (`revoked JWT ⇒ 401`) is tracked as production hardening.
- [ ] Strict **header validation** in the context middleware: missing/malformed `X-Tenant-Id` / required headers → **fail-closed reject**, never defaulted to `UNKNOWN` (SPEC §6, §10.2).
- [ ] `/health` and docs are the **only** unauthenticated routes; every other route 401s without a token.

### 3.2 Authorization decisions — PDP/PEP (`@aegis/access-control`) — `FLOW-AUTHZ-*`
- [ ] **RBAC core**: a role's permissions grant the dotted `domain.action` (e.g. `expense.report.approve`, `payroll.payslip.view.all`); absence ⇒ deny.
- [ ] **Allow + deny matrix** (§5) materialized as a table-driven Jest suite: `(role × permission × resource-scope) → expected verdict`.
- [ ] **ABAC refinement**: approver may approve only within own tenant and **up to an approval limit**; manager sees own cost-centre / own-and-team; owner-only edits.
- [ ] **Row-level scope** compiled into query predicates: `AllRecords | OwnAndTeam | OwnOnly` returns exactly the intended row set.
- [ ] **Obligations applied**: PEP enforces masking/column obligations returned by the PDP (payroll salary/bank/national-id).
- [ ] **Fail-closed**: PDP error / missing attribute ⇒ `deny`, never `allow`.
- [ ] **PEP everywhere**: a route-coverage test asserts **every** route is wrapped `authenticate → authorize(permission) → handler` (no naked handlers).
- [ ] **Decision cache** correctness: a cached allow does not survive a role/permission revocation (cache key + invalidation).

### 3.3 Dynamic role / permission CRUD — PAP (`user-management`) — `FLOW-PAP-*`
- [ ] Create a **custom role** (`tenant_id` non-null), attach permissions via `role_permissions`, assign to a user with a scope.
- [ ] A user's effective permissions change **at runtime** after the role is granted (no redeploy) — re-check a previously-denied action now allows.
- [ ] Revoke a permission/role → previously-allowed action now denies (and cached verdict invalidates).
- [ ] Only a principal holding the relevant PAP permission (`role.create`, `role.assign`, `policy.manage`) can mutate the catalog; others `403`.
- [ ] **Tenant scoping of PAP**: tenant A cannot read, edit, or assign tenant B's custom roles.
- [ ] Cannot grant a permission that does not exist in the catalog; cannot escalate beyond own granted set (no self-elevation).

### 3.4 Tenant isolation — `FLOW-TENANT-*` (release-blocking, L6)
- [ ] **Cross-tenant read** attempt via API: user in tenant A requests a tenant B resource id → `404`/`403`, **never** B's data.
- [ ] **Cross-tenant write/update/delete** attempt → rejected; B's rows unchanged (assert in DB).
- [ ] **List endpoints** never include other tenants' rows (assert row provenance, not just count).
- [ ] **RLS backstop**: connect as the **non-owner app role** (no `BYPASSRLS`), `SET LOCAL app.current_tenant = A`, run a deliberately tenant-blind `SELECT * FROM <table>` → returns **only** A's rows. Switch the session var to B → only B's rows.
- [ ] **`FORCE ROW LEVEL SECURITY` + `RESTRICTIVE` policy** verified: even a query *without* a tenant predicate is constrained by RLS.
- [ ] **Missing session var** (`app.current_tenant` unset) ⇒ zero rows (fail-closed), not all rows.
- [ ] **Correlation-id probing**: replaying another tenant's `X-Correlation-Id` does not grant access (correlation id is for stitching logs, carries no authority — SPEC §6).
- [ ] **Per-tenant config bleed**: tenant A's approval thresholds / connector config never apply to tenant B.

### 3.5 Per-service core flows
- **user-management** — `FLOW-UM-*`: current-tenant read, tenant user list/detail, invite issue/list/revoke, policy CRUD, team membership, session issue/revoke. Invite-token acceptance, membership workspace switching, and org hierarchy APIs remain hardening flows.
- **expense** — `FLOW-EXP-*`: report create (draft) → add expense items (user-entered, **header rollups; no GL codes, no extracted line items** — SPEC §5/§10.1) → submit → approval state machine `OPEN → APPROVALS → APPROVED/REJECTED → REIMBURSED`; ownership/role gates (owner edits; admin bypass; manager-of-submitter approves; same→same blocked; APPROVED terminal); on APPROVED → push to ERP via `@aegis/connectors`.
- **payroll** — `FLOW-PAY-*`: employee master create (with `*_enc` fields) → effective-dated contract → pay-run `DRAFT → CALCULATED → APPROVED → FUNDING → PAID` (+ `REVERSED`/`VOIDED`); **maker-checker** (approver ≠ input editor); field-level masking by role; inbound `payroll-inputs` (approved expense/bonus, idempotent); disbursement → `payment_batch` + append-only `ledger_entries`.
- **reporting** — `FLOW-RPT-*`: report definition → run → async export; **access-scope is part of every cache key**; row filter + **column masking** on output; never bypass RLS.
- **workflow** — `FLOW-WF-*`: rule (conditions-as-data `{field,operator,value,conjunction}`) triggered by a domain event → actions fire; rule audit log written.
- **notification** — `FLOW-NOTIF-*`: event consumed → templated in-app + email notification; **idempotent** (same event twice ⇒ one notification); consumes already-authorized events (never re-derives authority).
- **invoice** — `FLOW-INV-*`: invoice create (**header-level only** — SPEC §5/§10.1) → state machine → **matching = duplicate detection** (vendor + invoice_number + amount) + **threshold/variance vs optional PO reference + per-tenant limits** → approval routing.

### 3.6 Approval chains & maker-checker — `FLOW-APPR-*`
- [ ] Multi-level approval hierarchy (`approval_hierarchy(level)`, `approver_groups`, `record_approvers(threshold)`): each level must approve in order; `approval_progress_log` records progression.
- [ ] **Threshold routing**: an amount above a tenant limit routes to a higher approver; below it routes lower.
- [ ] **Approval limit (ABAC)**: an approver whose `approval_limit` is below the amount is denied even though they hold `*.approve`.
- [ ] **Maker-checker / segregation of duties** (payroll + expense + invoice): the principal who created/edited the inputs is **rejected** at the approve step; a *different* qualified principal succeeds. Assert the denial reason is SoD, not a generic 403.
- [ ] Self-approval blocked except the explicit "self-manager" rule where defined; double-approval guarded.
- [ ] Reject path returns the record to the correct prior state and logs the rejector + comment.

### 3.7 ERP connector framework — `@aegis/connectors` — `FLOW-ERP-*`
- [ ] **Adapter contract**: each mock connector (`LedgerOne`, `Finovo`, `AcctBridge`) implements the common interface (auth handshake, push transaction, fetch status); registry resolves the connector from per-tenant config.
- [ ] **Push on approval**: expense/invoice/payroll approved record → push transaction to the configured connector; status reflected back.
- [ ] **Idempotency**: re-pushing the same record (same idempotency key) does **not** create a duplicate at the connector; the second push is a no-op returning the prior reference.
- [ ] **Auth/context propagation**: connector calls carry internal-JWT + context + per-connector configured auth scheme (note: **no `X-Trend` header** — SPEC §10.3).
- [ ] **Failure handling**: a connector error surfaces to an integration-status record (queued/synced/error), not a swallowed failure.
- [ ] **Pluggability**: adding a new mock connector requires only a new adapter — a test asserts the registry picks it up with no core changes.

### 3.8 Notification idempotency — `FLOW-NOTIF-IDEM-*`
- [ ] Same domain event delivered twice (redelivery / outbox replay) ⇒ exactly **one** `notifications` row and **one** `email_notification_logs` send.
- [ ] Idempotency key derived deterministically from event identity; concurrent duplicate delivery still yields one send (unique constraint upheld).

### 3.9 Reporting access-scope & column masking — `FLOW-RPT-SEC-*`
- [ ] Two users with different scopes running the **same** report definition get **different** row sets — and the cache does **not** serve one user's rows to the other (**access-scope in the cache key**).
- [ ] **Column masking**: `report_access_policies(allowed_columns, masked_columns, row_filter)` honored — masked columns are redacted/absent in the artifact for an unentitled role.
- [ ] Export artifact (async, BullMQ) carries the same scope; downloading it later does not bypass authz.
- [ ] Reporting reads **never** bypass RLS (run as the non-owner role; assert no cross-tenant fact rows).

### 3.10 Audit + hash-chain integrity — `FLOW-AUDIT-*` (release-blocking, L4)
- [ ] Every write/sensitive-read emits an audit entry capturing **actor, tenant, intent, decision, permissions-at-time-of-action** (SPEC §1 Audit).
- [ ] **Hash-chain continuity**: entry *n*'s hash incorporates entry *n-1*'s hash; a verifier walks the chain and confirms an unbroken link.
- [ ] **Tamper-evidence**: mutating a historical audit row (or deleting one) breaks the chain → the verifier flags the exact broken link.
- [ ] **Payroll sensitive-field reads** (salary/bank/national-id) each produce an audit entry with `sensitive_read = true`.
- [ ] **Append-only enforcement**: `ledger_entries` and audit tables reject `UPDATE`/`DELETE` (corrections are reversal entries, not edits).
- [ ] Decision audit: both **allow and deny** verdicts are logged with their reason.

---

## 4. HOW to test each — tooling & patterns

### 4.1 Stack
- **Jest (+ ts-jest)** — all levels. Table-driven (`it.each`) for the decision/isolation matrices.
- **supertest** — HTTP assertions against a service's Express app (L2) and against the gateway (L3).
- **Real PostgreSQL** (ephemeral, from `docker-compose.yml`) — never a SQL mock; RLS only exists in a real engine. Migrations applied via the Umzug one-shot (`PROCESS_TYPE=migration`) before the suite.
- **raw `pg` as the non-owner app role** — the L6 RLS backstop must run as the *same* unprivileged role the app uses (no `BYPASSRLS`), so the test exercises the real policy.
- **`@aegis/events` in-process transport** for L2; the dockerized transport (Redis streams / BullMQ) for L3.
- **Mock `@aegis/connectors`** for all ERP paths — deterministic, in-memory, assertable call logs.
- **`libs/testing`** — shared `RequestContext` stubs, PDP stubs, token minters, and the fixture loader (§6).

### 4.2 Per-level recipe
- **L1 unit** — import the pure function (PDP `decide`, ABAC eval, state-machine `transition`, `chainHash(prev, payload)`, `maskColumns`), feed crafted inputs, assert the return. No DB, no HTTP. Target the branches: each allow reason, each deny reason, each illegal transition.
- **L2 integration** — boot the service container against ephemeral Postgres, `SET LOCAL app.current_tenant`, seed the fixture, drive HTTP with supertest, assert **(a)** response DTO + status, **(b)** error envelope shape on failures, **(c)** DB rows (§7), **(d)** audit entry written.
- **L3 E2E** — `docker compose` the gateway + the services in the flow + Postgres + Redis; mint a real token at the IdP; drive the flow through the gateway; assert the cross-service side effects (event consumed, notification sent, connector pushed, ledger posted) and end-to-end correlation-id stitching.
- **L5 security** — reuse L2/L3 harness but with adversarial principals/tokens; every case asserts a **deny** (status + envelope `code`/`type`) **and** that no state changed (DB unchanged).
- **L6 tenancy** — the RLS backstop runs SQL directly as the app role; the API-level cases run cross-tenant requests through supertest.

### 4.3 Example — decision matrix (L1/L5, table-driven)
```ts
// test/security/expense-approve.matrix.spec.ts
import { decide } from '@aegis/access-control';

const cases: Array<[role: string, scope: string, amount: number, allow: boolean, reason: string]> = [
  ['expense.approver', 'OwnAndTeam',  50_00,  true,  'rbac+abac: within limit, in tenant'],
  ['expense.approver', 'OwnAndTeam', 9_999_00, false, 'abac: above approval_limit'],
  ['expense.submitter','OwnOnly',    50_00,  false, 'rbac: lacks expense.report.approve'],
  ['expense.approver', 'OwnAndTeam',  50_00,  false, 'abac: resource in different tenant'], // cross-tenant resource
];

it.each(cases)('approver=%s scope=%s amount=%i → allow=%s (%s)', (role, scope, amount, allow) => {
  const verdict = decide(
    principal({ roles: [role], scope, tenantId: 'tenant-a' }),
    'expense.report.approve',
    resource({ tenantId: amount === 50_00 ? 'tenant-a' : 'tenant-b', amount, ownerTeam: 'team-1' }),
    context({ now: FIXED_CLOCK }),
  );
  expect(verdict.allow).toBe(allow);
  if (!allow) expect(verdict.reason).toBeTruthy(); // fail-closed carries a reason
});
```

### 4.4 Example — RLS backstop (L6, raw SQL as the app role)
```ts
// test/tenancy/rls-backstop.spec.ts  — runs as the NON-OWNER app role (no BYPASSRLS)
it('FORCE RLS constrains a tenant-blind SELECT to the session tenant', async () => {
  await appRole.query("SET LOCAL app.current_tenant = 'tenant-a'");
  const a = await appRole.query('SELECT tenant_id FROM expense_reports'); // deliberately no WHERE
  expect(a.rows.every(r => r.tenant_id === 'tenant-a')).toBe(true);

  await appRole.query("RESET app.current_tenant");
  const none = await appRole.query('SELECT * FROM expense_reports');     // var unset → fail-closed
  expect(none.rows).toHaveLength(0);
});
```

### 4.5 Example — cross-tenant IDOR (L5/L6, supertest)
```ts
// test/security/idor-payslip.spec.ts
it('FLOW-TENANT-03: tenant A cannot read tenant B payslip by id', async () => {
  const res = await request(gateway)
    .get(`/payroll/v1/payslips/${SEED.tenantB.payslipId}`)
    .set('Authorization', `Bearer ${tokenFor(SEED.tenantA.payrollAdmin)}`);
  expect(res.status).toBe(404);                       // not 403 — don't confirm existence
  expect(res.body).not.toHaveProperty('data.net');    // no leak in body
  // DB witness: B's row untouched, and an audit deny was recorded for tenant A
  const b = await db.query('SELECT net_enc FROM payslips WHERE id=$1', [SEED.tenantB.payslipId]);
  expect(b.rows[0].net_enc).toBe(SEED.tenantB.payslipNetEnc);
});
```

---

## 5. Authorization decision matrix (allow + deny)

This matrix is the **canonical source** for the table-driven L5 suite. It is illustrative for v1 and
grows with the role catalogue; every cell becomes a Jest case. `✓` = allow, `✗` = deny (fail-closed),
`◐` = allow **with obligation** (e.g. column masking / row-scope filter applied).

| Principal role | `expense.report.approve` (own tenant, ≤ limit) | `expense.report.approve` (above limit) | `payroll.payslip.view.own` (own) | `payroll.payslip.view.all` (other employee) | `payroll.run.approve` (edited inputs) | `role.create`/`role.assign`/`policy.manage` (PAP) | cross-tenant resource (any action) |
|---|---|---|---|---|---|---|---|
| **Tenant admin** | ✓ | ✗ (limit still applies) | ✓ | ✓ | ✓ (unless they edited → SoD ✗) | ✓ | ✗ |
| **Expense approver / manager** | ✓ | ✗ | — | — | — | ✗ | ✗ |
| **Expense submitter (owner)** | ✗ (lacks perm) | ✗ | — | — | — | ✗ | ✗ |
| **Payroll processor (editor)** | — | — | ◐ (masked) | ◐ (masked) | ✗ (**maker-checker**) | ✗ | ✗ |
| **Payroll approver** | — | — | ◐ | ◐ | ✓ (if ≠ editor) | ✗ | ✗ |
| **Finance disburser** | — | — | ◐ | ◐ | ✗ | ✗ | ✗ |
| **Manager (own-team)** | ✓ (team scope) | ✗ | ◐ (team only) | ✗ (non-team) | ✗ | ✗ | ✗ |
| **Employee (self)** | ✗ | ✗ | ✓ (own only) | ✗ | ✗ | ✗ | ✗ |
| **Auditor (read-only)** | ✗ | ✗ | ◐ (read, masked) | ◐ (read, masked) | ✗ | ✗ | ✗ |
| **Unauthenticated** | ✗ (401) | ✗ (401) | ✗ (401) | ✗ (401) | ✗ (401) | ✗ (401) | ✗ (401) |

Notes encoded as assertions: the **cross-tenant column is all `✗`** for every role (no role grants
cross-tenant authority); PAP mutation permissions are admin-only and **tenant-scoped**; payroll reads are
`◐` (masked) for everyone but the entitled processor/approver on the salary/bank/national-id columns;
**maker-checker** turns an otherwise-✓ approve into `✗` when the approver edited the inputs.

---

## 6. The seeded multi-tenant fixture

A single deterministic fixture underpins L2–L6 so cross-tenant tests have real "other-tenant" data to
*fail* to reach. Loaded by `libs/testing` before each suite (idempotent: truncate-and-seed inside a
transaction or a throwaway schema).

### 6.1 Shape
- **Two tenants** — `tenant-a` (`Acme`) and `tenant-b` (`Globex`) — fixed UUIDs. `tenant-b` exists
  **only** so isolation tests have something to try (and fail) to read.
- **Roles per tenant**: system roles seeded + at least one **custom role** per tenant (to exercise PAP
  and tenant-scoped role isolation).
- **Users per tenant** spanning every role in §5: admin, expense submitter/approver/manager,
  payroll processor/approver/disburser, manager (own-team), employee (self), auditor.
- **Org hierarchy**: a manager → reports edge with an `approval_limit`, in each tenant.
- **Domain seed**: ≥1 expense report (with header rollup items), ≥1 invoice (header-level), ≥1
  employee with `*_enc` fields + a contract, ≥1 draft pay-run, ≥1 report definition with an access
  policy (allowed/masked columns), connector config pointing at a **mock** connector.
- **Pre-computed expected values** exported as constants (`SEED.tenantB.payslipNetEnc`, ids, hashes)
  so tests assert exact DB state without recomputing.
- **Fixed clock + PRNG seed** so effective-dated rules, idempotency keys, and the audit hash-chain are
  reproducible.

### 6.2 Invariants the fixture itself asserts (a meta-test)
- Every seeded row has a non-null `tenant_id`.
- No id collides across tenants; no permission references a missing catalog row.
- The maker-checker fixture has a distinct editor and approver available for the approve flows.

---

## 7. DB-verification approach (which tables/rows to assert)

For every state-changing flow, the test asserts DB state in addition to the HTTP response. The
catalogue entry for each flow names its **DB witnesses**. Baseline map:

| Flow area | Tables to assert | What to check |
|---|---|---|
| **Expense submit/approve** | `expense_reports`, `expense_approvals`, `expense_activities`, `audit_log` | status transition is legal; one approval row with correct approver; activity + audit emitted; no cross-tenant rows |
| **Invoice matching** | `invoices`, `invoice_duplicates`, `invoice_approvals`, `invoice_activities` | duplicate detected on (vendor, invoice_number, amount); variance vs PO ref within tenant limit; approval routed; **no line-item / GL tables exist** |
| **Payroll run** | `pay_runs`, `payslips`, `payslip_lines`, `payroll_input_items`, `ledger_entries`, `payments`, `payment_batches`, `audit_log` | status lifecycle; `approved_by ≠ editor`; net math = gross − tax − post-tax; **ledger append-only & balanced**; sensitive-read audit rows; idempotent inputs (unique `idempotency_key`) |
| **PAP role CRUD** | `roles`, `role_permissions`, `user_roles`, `policies`, `audit_log` | custom role `tenant_id` set; mapping rows exact; grant scoped to tenant; mutation audited |
| **Tenant isolation** | *any tenant-scoped table* | as the app role with RLS: only session-tenant rows returned; target tenant's rows unchanged after a cross-tenant write attempt |
| **ERP push** | connector call-log (mock) + integration-status rows | exactly-once push per idempotency key; status reflected; failure recorded not swallowed |
| **Notification** | `notifications`, `email_notification_logs` | exactly one row per event identity on redelivery |
| **Reporting** | `report_runs`, `report_access_policies`, cache entries | scope in cache key; masked columns absent from artifact; no cross-tenant fact rows |
| **Audit** | `audit_log` (+ per-domain audit tables) | hash-chain continuity; tamper breaks the chain; allow+deny both logged with reason |

**Append-only assertion pattern**: attempt an `UPDATE`/`DELETE` on `ledger_entries` / audit tables as
the app role and assert it is rejected (trigger/grant), then assert a **reversal** entry is the
sanctioned correction path.

---

## 8. Recording test runs — structured result format

Every executed run (CI, nightly agent, or manual) is recorded in a structured, machine-readable shape
so results are comparable over time and the bug-hunting agent can diff them.

### 8.1 Per-test result record (JSON, emitted by a Jest reporter)
```json
{
  "flowId": "FLOW-TENANT-03",
  "title": "Tenant A cannot read Tenant B payslip by id",
  "level": "L6",
  "area": "tenant-isolation",
  "priority": "P0",
  "status": "pass",
  "startedAt": "2026-06-27T02:14:09Z",
  "durationMs": 412,
  "assertions": [
    { "kind": "http", "expected": "status 404", "actual": "404", "ok": true },
    { "kind": "db",   "table": "payslips", "expected": "net_enc unchanged", "ok": true },
    { "kind": "audit","expected": "deny verdict logged for tenant-a", "ok": true }
  ],
  "evidence": {
    "request": "GET /payroll/v1/payslips/<id> (token: tenant-a payrollAdmin)",
    "correlationId": "c-7f3a…",
    "dbQueries": ["SELECT net_enc FROM payslips WHERE id=$1"],
    "recordingRef": "recordings/FLOW-TENANT-03.mp4#t=12"
  },
  "commit": "<git-sha>"
}
```

### 8.2 Run summary
A roll-up per run: `{ runId, commit, startedAt, totals: { pass, fail, skipped }, byArea, byLevel, blockingRed: [...], newBugs: ["BUG-0007"] }`, written to `test-results/<runId>.json` and surfaced in CI. **Any `P0`/release-blocking red sets `blockingRed` and fails the run.**

### 8.3 Pass/fail policy
- `pass` — all assertions ok.
- `fail` — any assertion failed → the reporter **auto-drafts a `BUGLOG.md` entry** (§9) with `flowId`, repro, expected vs actual, DB evidence.
- `skipped` — feature not yet landed (allowed for `[ ]` items); skipped P0 flows are reported but do not block until their feature is marked done in `IMPLEMENTATION_PLAN.md`.
- **Regression rule**: a fixed `BUG-NNNN` must ship with a `@regression`-tagged test; re-opening is a hard failure.

### 8.4 Flow recordings (annotation format)
Tooling chosen later (SPEC §10.6); the format is fixed now. Each recorded flow ships a sidecar
`recordings/<flowId>.json`:
```json
{
  "flowId": "FLOW-EXP-APPROVE-01",
  "title": "Submit and approve an expense report",
  "service": "expense",
  "steps": [
    { "t": 0,  "action": "Submitter creates draft report", "expect": "201, status=OPEN" },
    { "t": 8,  "action": "Submitter submits", "expect": "status=APPROVALS; approval routed by threshold" },
    { "t": 19, "action": "Submitter tries to approve own report", "expect": "403 maker-checker (deny)" },
    { "t": 27, "action": "Manager approves", "expect": "status=APPROVED; ERP push (mock LedgerOne); audit chained" }
  ],
  "result": "pass",
  "annotatedBy": "nightly-agent",
  "links": { "flow": "docs/testing/flow-catalogue.md#flow-exp-approve-01" }
}
```
The annotation makes each recording self-describing: **what is done, what is expected, whether it
passed** — organized and shareable, per SPEC §10.6. Cross-linked from
[`docs/testing/flow-recording.md`](docs/testing/flow-recording.md).

---

## 9. Scheduled bug-hunting agent

An autonomous agent (overnight + after features land, per SPEC §10.6/§10.8) exercises flows **in
conjunction**, verifies DB state and cross-service correctness, and appends findings to
[`BUGLOG.md`](BUGLOG.md).

### 9.1 Cadence
- **Nightly** full pass once at least one phase's features are marked done in `IMPLEMENTATION_PLAN.md`.
- **On green build → promote** in CI (smoke subset).
- **Auto-resume** after the 5-hourly usage-limit window and overnight (single top-level agent, may
  fan out sub-agents within a pass).

### 9.2 What it runs (each pass)
1. Bring up a fresh dockerized stack (`scripts/dev-up.sh`) + seed the multi-tenant fixture.
2. Run the **full L3–L6 matrix**: cross-service E2E flows, the authz allow+deny matrix, tenant-isolation + RLS backstop, data-integrity (ledger/audit/idempotency).
3. **Conjunction / soak flows** the unit suites miss: interleave two tenants concurrently and assert no bleed; replay the event bus to prove notification/ERP idempotency; run a pay-run + an inbound expense reimbursement and reconcile the ledger; mutate an audit row mid-run and confirm the verifier flags it.
4. **DB-state & data-integrity sweeps**: every append-only table rejects edits; hash-chain verifier walks each tenant's audit log; orphan/dangling-FK scan; idempotency-key uniqueness scan.
5. Diff this run's structured results (§8) against the previous green run to spot **regressions**.

### 9.3 How it appends to `BUGLOG.md`
For each `fail`, append **one self-contained row** matching the existing
[`BUGLOG.md`](BUGLOG.md) table (do not change its schema):

`| ID | Date | Flow / Area | Severity | Status | Summary | Expected | Actual | Repro | Fix / commit |`

- **ID**: next `BUG-NNNN` (zero-padded, monotonic).
- **Flow / Area**: the `FLOW-…` id from [`docs/testing/flow-catalogue.md`](docs/testing/flow-catalogue.md).
- **Severity**: `blocker` (tenant leak / authz bypass / ledger or hash-chain corruption / money double-pay), `high`, `medium`, `low`, `nit`.
- **Status**: opens as `open`.
- **Repro**: exact request/command + inputs + the seed principal, plus the **DB witness** checked.
- **Expected vs Actual**: from the failing assertion record (§8.1).
- Group related findings; **never duplicate** an existing open entry (dedupe on flow id + assertion signature).

Example appended row:
```
| BUG-0007 | 2026-06-27 | FLOW-TENANT-03 / tenant-isolation | blocker | open | Cross-tenant payslip readable by id | 404, no body leak | 200 with net_enc of tenant-b | GET /payroll/v1/payslips/<B-id> as tenant-a payrollAdmin; RLS session var was tenant-a | |
```

### 9.4 Guardrails
- The agent **never edits tests to make them pass** and **never deletes** `BUGLOG.md` history
  (append-only). It opens bugs; humans/fix-agents resolve them and add the `@regression` test +
  fixing commit. It honors the neutral-naming rules from [`AGENTS.md`](AGENTS.md) §3 in any text
  it writes (no donor branding; Aegis is presented as a production enterprise platform).

---

## 10. Linkage to the flow catalogue & recording plan

- [`docs/testing/flow-catalogue.md`](docs/testing/flow-catalogue.md) is the **per-flow registry**:
  one entry per end-to-end flow (`FLOW-<AREA>-NN`) with — *id, title, services touched, preconditions
  (seed principal + tenant), steps, expected result, **DB witnesses** (§7), authz allow+deny pairs,
  priority, and a link to its test file + recording*. This plan defines the **levels, areas, matrix,
  fixture, and result format**; the catalogue enumerates the **concrete flows**. Every `[ ]` in §3
  becomes one or more catalogue rows.
- [`docs/testing/flow-recording.md`](docs/testing/flow-recording.md) holds the **recording plan**:
  the ordered flow list to capture, the annotation sidecar format (§8.4), and (later) the chosen
  capture tooling. Recordings are organized by service and cross-link back to the catalogue and to
  the structured run results.
- [`BUGLOG.md`](BUGLOG.md) closes the loop: failures found while exercising catalogued flows are
  logged with the flow id, then fixed and regression-locked.

---

## 11. Test areas × level × priority

`P0` = release-blocking (security/tenancy/integrity correctness). `P1` = core functionality.
`P2` = breadth/edge. `●` = primary level for the area; `○` = also exercised there.

| Test area | L1 unit | L2 integ | L3 E2E | L4 integrity | L5 security | L6 tenancy | L7 regr. | Priority |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Authentication (token/JWKS/revocation/header-validation) | ● | ● | ○ | | ● | | ○ | **P0** |
| Authorization decisions (RBAC + ABAC, allow+deny matrix) | ● | ● | ○ | | ● | ○ | ○ | **P0** |
| Dynamic role/permission CRUD (PAP) | ○ | ● | ○ | | ● | ● | ○ | **P0** |
| Tenant isolation (API leaks + RLS backstop) | | ○ | ○ | ○ | ● | ● | ○ | **P0** |
| Audit + hash-chain integrity | ● | ○ | | ● | ○ | | ○ | **P0** |
| Maker-checker / segregation of duties | ● | ● | ● | ○ | ● | | ○ | **P0** |
| Payroll field masking + sensitive-read audit | ● | ● | ○ | ○ | ● | ○ | ○ | **P0** |
| ERP connector push + idempotency (mock) | ● | ● | ● | ● | ○ | ○ | ○ | P1 |
| Notification idempotency | ● | ● | ● | ● | | ○ | ○ | P1 |
| Approval chains / threshold routing | ● | ● | ● | ○ | ○ | ○ | ○ | P1 |
| Expense core flow (submit→approve→ERP) | ○ | ● | ● | ○ | ○ | ○ | ○ | P1 |
| Invoice core flow (header matching/dedupe/variance) | ● | ● | ● | ○ | ○ | ○ | ○ | P1 |
| Payroll run lifecycle + ledger | ● | ● | ● | ● | ○ | ○ | ○ | P1 |
| user-management core (tenants/users/memberships/sessions) | ○ | ● | ○ | | ○ | ● | ○ | P1 |
| Workflow rules-as-data engine | ● | ● | ● | ○ | ○ | ○ | ○ | P1 |
| Reporting access-scope + column masking | ● | ● | ● | ○ | ● | ● | ○ | **P0** |
| Context propagation / correlation-id stitching | ○ | ● | ● | | ○ | ○ | ○ | P1 |
| Cross-service conjunction / soak (nightly) | | | ● | ● | ○ | ● | ○ | P1 |

---

## 12. Living-plan checklist (track here)

- [ ] `libs/testing` fixture loader + seeded multi-tenant fixture (§6) landed.
- [ ] Jest config + custom JSON reporter (§8) wired into `nx`.
- [ ] L0 forbidden-name + dead-route scans in CI.
- [ ] PDP/PEP decision-matrix suite (§5) green (allow **and** deny).
- [ ] RLS backstop suite (L6) green as the non-owner app role.
- [ ] Audit hash-chain verifier + tamper test (L4) green.
- [x] `docs/testing/flow-catalogue.md` authored; every §3 `[ ]` mapped to a `FLOW-…` entry.
- [x] `docs/testing/flow-recording.md` authored; annotation sidecar format adopted.
- [ ] Scheduled bug-hunting agent (§9) scheduled; first nightly pass appends to `BUGLOG.md`.
- [ ] Coverage gate enforced per service (Definition of Done — `AGENTS.md` §8).

> **Last updated:** 2026-06-27. Keep this date current and tick boxes as tests land
> (Documentation discipline — `AGENTS.md` §9).
