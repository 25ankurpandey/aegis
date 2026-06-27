# Aegis — Business-Logic Completeness Audit (vs SPEC + reference domains)

**Auditor:** Principal-engineer business-logic completeness review.
**Source of truth:** `SPEC.md` (esp. §2 access-control model, §5 data model, §10 amendments, §11 realignment v2).
**Domain reference:** the domain reference (deep approval engine, currency, expense/invoice lifecycles) — reference only.
**Scope:** every domain service under `apps/*/src/services/**` + `libs/approvals` + `libs/access-control` + `libs/audit`,
read at file:line on both sides. Out-of-scope per SPEC §10.1: GL codes, document-extracted line items, invoice PO/matching/threshold —
those omissions are NOT flagged here.

**Legend:** ✓ implemented & SPEC-aligned · ◑ partial · ✗ missing / not wired.

---

## Executive verdict

The **schema, the access-control substrate (Casbin + RLS), the per-domain state machines, the audit hash-chain, the transactional
outbox, and field-level payroll crypto are genuinely strong and SPEC-faithful.** Waves 1–4 of `HARDENING_BACKLOG.md` have largely
landed (reject/reimburse paths, comments/recall, partial-unique indexes, advisory-locked audit tail, outbox+DLQ, ERP-push-as-event).

The material business-logic gap is one of **integration, not construction**: the advertised **shared multi-level approval engine
(`@aegis/approvals`) is fully built but completely orphaned** — no domain service calls it, and no service consumes its
`ApprovalCompleted` event. Expense/invoice/payroll each still run an **inline, single-shot, single-level approval** that ignores
the engine, its policies, thresholds, manager-chain resolution, quorum, delegation, and vote ledger. The enterprise capability
exists in code but is not wired to anything, so at runtime the platform behaves as three siloed single-approver flows. Secondary
material gaps: the Casbin enforcer never reloads after PAP mutations (stale authz on running pods), the ABAC/row-scope PDP layer is
effectively dead (no controller feeds it policies), payroll tax is hard-zeroed while `tax_rules` is never read, sensitive-field
reads are not audited (SPEC §2.5 violation), and feature flags are read uncached on a fresh transaction per call.

---

## Per-domain assessment

### 1. Expense / expense-reports — ◑ partial (lifecycle complete; not on shared engine)

**Implemented ✓**
- Full header state machine with role-keyed transition maps (submitter/manager/finance) — `apps/expense/src/services/expense.service.ts`
  (`approveReport` :334, `rejectReport` :407, `reimburseReport` :475, `submitReport` :294, `recallReport` :190).
- Reject path + Rejected→Open resubmit and the FINANCE reimburse branch are now reachable (W1-08/09 landed; B2 D1 regression closed).
- Comments (`addComment` :149 / `listComments` :174) + report detail (`getReportDetail` :122) (W3-13 landed).
- RLS via `withTenantTransaction`, activity rows, audit state-transitions, outbox-staged domain events, ERP push as event.

**Partial / not wired ◑**
- **Approval is inline single-level, NOT the shared engine.** `approveReport` writes one `expense_approvals` row hardcoded
  `level: 1` and flips status directly (`expense.service.ts:~352`). It never calls `ApprovalService.requestApproval/decide`.
  Multi-level chains, thresholds, manager resolution, quorum, delegation, and the immutable vote ledger that `@aegis/approvals`
  provides are unreachable for expense. The domain reference treats multi-level approval as the core of the expense surface.
- **Mixed-currency report total** — items can be attached in a currency ≠ the report currency and are summed by raw minor units
  (`attachExpenseToReport` :241). W1-10 was specced; verify the guard actually rejects/converts before ERP push (the domain reference rolls up
  via a per-company conversion-rate table; Aegis has none).

### 2. Invoice (header-level) — ◑ partial (lifecycle + dedup good; approval inline; dedup race)

**Implemented ✓**
- Receive → duplicate-detect → Validating → PendingReview → ForApproval → Approved lifecycle, with a stable SHA-256 duplicate
  signature over (vendor+number+amount+currency) and an `invoice_duplicates` row — `apps/invoice/src/services/invoice.service.ts`
  (`create` :49, `submit` :162, `approve` :212).
- Outbox-staged `InvoiceReceived`/`InvoiceApproved` + `ConnectorPushRequested` (ERP push off the request path, W2-07).

**Partial / not wired ◑ / ✗**
- **Approval is inline single-shot** (`approve` :212 writes one `invoice_approvals` row at `input.approvalLevel ?? 1` and sets
  Approved). Does not use `@aegis/approvals`; "multi-level approval binding" (SPEC §0 invoice row) is not actually exercised.
- **Duplicate detection is read-then-write with no unique constraint** (`findDuplicateCandidate` :86). The dedup index
  `invoices_tenant_vendor_idx` is non-unique (`0002_invoice.ts:72`) — by design, but it means two concurrent `create()` calls for
  the same (vendor, number, amount) can both pass the `findDuplicateCandidate` check and both insert as non-duplicate (lost-update
  race → the same invoice paid twice, the exact failure the guard exists to prevent). Needs a partial-unique index or
  `SELECT … FOR UPDATE`/serializable to be safe under concurrency. (W2-10 noted the index but punted the uniqueness decision.)

### 3. Payroll (maker-checker / ledger / disburse) — ◑ partial (SoD + ledger strong; tax & concurrency gaps)

**Implemented ✓**
- Strict Draft→Calculated→Approved→Paid state machine with **maker-checker SoD as a hard domain invariant** (approver ≠ creator,
  enforced as a 403 not a config) — `apps/payroll/src/services/pay-run.service.ts:143`.
- **Idempotent disbursement** (per-payslip idempotency key `${idempotencyKey}:${slip.id}`, :223) + **balanced append-only
  double-entry ledger** (Dr wage expense / Cr cash+tax+deduction, :244–259) + locked computation snapshot at approve (:149).
- Field-level AES-256-GCM encryption of salary/bank/national-id with decrypt-then-mask on read, clear only with
  `payroll.sensitive.read` — `employee.service.ts` + `utils/field-crypto.ts`.

**Partial / missing ◑ / ✗**
- **Tax is hard-coded to zero** and the `tax_rules` (jurisdiction, effective-dated) table is **never consulted** —
  `computeForEmployee` :123 (`const totalTax = 0`). SPEC §5 lists `tax_rules(jurisdiction, effective_dated)` and §0 calls payroll
  "jurisdiction-keyed tax config" as first-class. Net/ledger math is therefore always gross-minus-deductions; a real pay run
  would be wrong. The pre-tax-deduction path is also dead (`preTaxDeductions = 0` const, :112) so all deductions are post-tax.
- **No optimistic lock on `pay_runs`** — `calculate`/`approve`/`disburse` are read-modify-write inside a transaction but rely only
  on `assertStatus`; two concurrent `approve` calls can both read `Calculated` and race (W2-08 specced version columns; verify
  applied to `pay_runs`). The SoD check + status assert reduce but do not eliminate the window.
- **Sensitive-field reads are NOT audited.** SPEC §2.5 mandates "audit every sensitive-field read"; `employee.service.ts` decrypts
  clear PII when `canReadSensitive` but writes no `AuditLogger.record` for the read. This is a compliance (SOC2/GDPR) gap, not just
  a nicety — there is no trail of who viewed a national id / bank account.
- **Payslip currency hard-coded `'USD'`** at seed (`create` :68) and ledger entries hard-code `currency: 'USD'` (:245) regardless
  of payslip currency — multi-currency payroll silently mislabels the ledger.
- **`approve` is not on the shared engine** either — maker-checker is a bespoke invariant rather than a configurable
  `@aegis/approvals` SoD policy (W3-01 explicitly wanted maker-checker carried into the shared engine as an invariant).

### 4. RBAC + Casbin — ◑ partial (engine correct; runtime policy-staleness + dead ABAC)

**Implemented ✓**
- Casbin RBAC-with-domains model, **`dom = tenantId`** (real per-tenant isolation, not the domain reference's `'*'` hack) —
  `libs/access-control/src/enforcer.ts:19`; fail-closed `enforce` wrapper (:101).
- Per-route PEP `authenticate() → authorize(permission)` calling `enforce(roleOrUser, tenantId, permission)`, allow-if-any-role,
  fail-closed — `pep.ts:122`.

**Partial / missing ◑ / ✗**
- **Enforcer is a build-once process singleton with no reload** — `pep.ts:72` (`enforcerPromise` cached forever; `loadPolicy()`
  called once in `createEnforcer`). The PAP (`pap.service.ts`) creates roles and assigns role→permission at runtime, but **nothing
  reloads or watches the Casbin policy table**. Result: a newly created/edited role or grant is invisible to every already-running
  api pod until restart — "dynamic roles/permissions (runtime CRUD)" (SPEC §1, §2.2 PAP) does not actually take effect at runtime.
  Enterprise fix: a Casbin Watcher (pg/redis) or an explicit `enforcer.loadPolicy()` after PAP writes + a publish/subscribe
  invalidation, or `loadFilteredPolicy` per tenant on a TTL.
- **The ABAC / row-level-scope PDP layer is effectively dead.** `authorize()` only runs `decide()`/`checkRowScope` when the route
  supplies `opts.policies` or `opts.resource` (`pep.ts:150–171`), but **no controller passes `policies:`** (grep: zero hits across
  `apps/*/src/controllers`), and **only `expense-report.controller.ts` passes `resource:`**. So the ABAC condition engine
  (`pdp.ts:decide`, `condition-evaluator`) and obligations/column-masking that SPEC §2.3 advertises are not exercised in practice —
  the platform is RBAC-only at runtime. SPEC §2.5 examples ("approver can approve up to $X", "manager sees their cost-center")
  have no enforcement path.

### 5. Workflow / rule-events — ✓ mostly (trigger contract fixed; one orphan event class)

**Implemented ✓**
- Rules-as-data engine (steps with field/operator/value/conjunction AND/OR, dispatch matched actions, dry-run) —
  `apps/workflow/src/services/rule.service.ts` (`evaluateRules` :75, `runRule` :87, `executeRule` :96).
- **Trigger contract is now correct** (W1-03 landed): `TOPIC_TO_RULE_EVENT` maps the ACTUAL emitted topics
  (`ExpenseSubmitted/InvoiceReceived → RecordSubmitted`, `*Approved → ApprovalCompleted`) — `consumers/index.ts:26`. The dead
  `record.created/updated` subscriptions (no producer) are gone, and a documented loop-guard keeps the engine from consuming a
  topic it produces.

**Partial ◑**
- `RuleEvent.ApprovalCompleted` is fed by the **inline** `*Approved` domain topics — correct today, but once the shared approval
  engine is wired (it emits its own `ApprovalCompleted` event, distinct from the domain `*Approved` topics), there will be **two
  sources of "approval completed"** and the workflow map must be reconciled to avoid double-firing or missing the engine path.

### 6. Approvals (`@aegis/approvals`) — ✗ built but ORPHANED (the central gap)

**Implemented ✓ (the library itself is excellent)**
- Full multi-level engine: per-tenant policy resolution, amount thresholds (W3-03), manager / manager-chain resolution (W3-05),
  approver-group expansion + quorum (W3-04), sequential vs parallel per-level modes (W3-08), reassign/supersede with full history
  (W3-06), immutable append-only vote ledger, no-double-vote guard, SoD `excludeRequester` hook, outbox-staged
  `ApprovalRequested`/`ApprovalCompleted` — `libs/approvals/src/approval.service.ts` + `resolver.ts`. RLS-scoped, atomic, tested
  (`approval.service.spec.ts`, `approval.resolution.spec.ts`).

**Missing ✗ (integration)**
- **No domain service imports or calls it.** Grep across `apps/`: the only references to `@aegis/approvals`/`ApprovalService`/
  `requestApproval` are a migration comment and the workflow topic map — **zero call sites in expense, invoice, or payroll.**
- **No service consumes `ApprovalCompleted`.** The engine stages `ApprovalCompleted` to advance the owning record, but no
  consumer exists to flip the expense/invoice/pay-run status when the chain resolves. The engine, if called, would route and
  resolve approvals into a void.
- **Net effect:** the headline enterprise capability ("one configurable, tenant-scoped multi-level approval engine for every record
  type", SPEC §0/§5/§11) is **not in the runtime path**. This is the single most material business-logic gap and the precise doubt
  Part 4 of `HARDENING_BACKLOG.md` flagged — W3-01 built the lib but the three inline `approve()` call sites were never rewritten to
  use it, and the completion consumer was never built.

### 7. Notifications — ✓ good

**Implemented ✓**
- Idempotent email send via a **FOR-UPDATE idempotency ledger** (lock the unique-keyed row, short-circuit if already sent) —
  `email-sender.service.ts:12`. Template engine + SMS port + recipient resolver present (W3-09/12 landed). `ApprovalRequested`
  consumer wired to `NotificationCode.ApprovalRequested` (`notification.consumer.ts:69`).

**Partial ◑**
- Recipients today come from producer-supplied `recipientUserId` hints (e.g. invoice approve names `submitted_by ?? created_by`).
  Once the shared approval engine drives notifications, the recipient-resolver (W3-09) should derive the approver pool from the
  chain rather than from a single producer hint, or multi-approver levels will under-notify.

### 8. Activity tracking — ◑ partial

**Implemented ✓**
- Per-domain activity rows on the busy aggregates: `expense_activities`, `invoice_activities` (with correlation id) written in-tx.

**Partial ◑**
- No shared polymorphic activity surface across payroll/user-management/workflow/reporting (W3-11 specced `entity_activities`
  helper; not evident in payroll/pap services — they write audit but not a uniform activity feed). SPEC §0 frames audit as a
  "generic append-only activity feed + per-domain audit tables"; the generic feed is per-domain-only today.

### 9. Audit — ✓ strong

**Implemented ✓**
- Hash-chained, tamper-evident, permissions-at-time audit with `verifyChain`. **Tail concurrency fixed** (W1-11 landed): a
  transaction-scoped `pg_advisory_xact_lock` per tenant serializes tail-read→hash→insert, correctly handling the empty-table
  first-writer fork that a row `FOR UPDATE` cannot (`libs/audit/src/audit-logger.ts:47`). Ordering by monotonic sequence.

**Gap (covered above, not re-counted):** sensitive-field reads in payroll are not routed through `AuditLogger` (SPEC §2.5).

### 10. Multi-tenancy / RLS — ✓ strong

**Implemented ✓**
- Every domain repo goes through `withTenantTransaction` (RLS `SET LOCAL app.current_tenant`); `FORCE`+`RESTRICTIVE` policies,
  `tenant_id NOT NULL` everywhere, tenant-scoped unique constraints, partial-unique on soft-delete tables (W1-07). This exceeds the
  domain reference and is the platform's strongest area.

### 11. Tenant config / feature flags — ◑ partial

**Implemented ✓**
- `tenant_config` + `tenant_features` tables + a `tenant-config.service.ts` with `isFeatureEnabled` / `setFlag` / `setConfig`,
  audited, RLS-scoped (SPEC §11.5).

**Partial ◑**
- **No caching / no `@aegis/service-core` flag helper.** `isFeatureEnabled(flag)` opens a fresh `withTenantTransaction` and hits the
  DB **every call** (`tenant-config.service.ts:54`). SPEC §11.5 asked for "a `@aegis/service-core` helper to read flags; gate
  features by flag." A flag checked on a hot path (per request) is a per-request extra transaction + round-trip — an N+1-class cost
  at scale with no invalidation story. Needs a cached, context-aware helper with TTL/pub-sub invalidation on `setFlag`.
- No evidence of features actually being **gated** by a flag in the domain services (the helper exists; few/no call sites consume
  it), so "gate features by flag" is administratively possible but not exercised.

---

## Cross-cutting enterprise-scale risks (summary)

| Risk | Where | Why it fails at scale |
|---|---|---|
| Casbin enforcer never reloads after PAP writes | `pep.ts:72`, `pap.service.ts` | Runtime role/permission CRUD has no effect until pod restart |
| Shared approval engine orphaned | `approve()` call sites in expense/invoice/payroll | Advertised multi-level/threshold/manager/quorum approvals never run |
| ABAC/row-scope PDP unused | controllers pass no `policies:` | Amount-cap / manager-scope / column-mask obligations not enforced |
| Invoice dedup race | `invoice.service.ts:101` (no unique index) | Concurrent submits → same invoice paid twice |
| Payroll tax hard-zeroed | `pay-run.service.ts:123` | Net pay + ledger wrong; `tax_rules` never read |
| pay_run / invoice lacking optimistic lock | services rely on `assertStatus` | Concurrent approve/disburse races |
| Sensitive-field reads unaudited | `employee.service.ts` | SOC2/GDPR: no trail of PII access (SPEC §2.5) |
| Feature flag read = DB tx per call, uncached | `tenant-config.service.ts:54` | Per-request extra round-trip, no invalidation |

These are appended as **Wave 5** items in `HARDENING_BACKLOG.md`.
