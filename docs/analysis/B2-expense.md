# B2 — Expense + Expense-Report Domain Completeness (Track B, the domain reference)

**Auditor:** Principal-engineer reference-fidelity review
**Scope:** Aegis `apps/expense` + `apps/cli/src/migrations/0003_expense.ts`, audited against the domain reference expense / expense-report / approval / currency domain.
**References:** the domain reference (DOMAIN), the architecture reference (ARCHITECTURE).
**Standing scope decision (SPEC §10.1):** Aegis deliberately drops document-extracted **line items** and **GL codes**. Those omissions are NOT flagged. Only **header-level** enterprise gaps are flagged.

---

## Reference approach (the domain reference)

the domain reference is a production AP-automation / invoice-processing platform. Its "expense report" surface (`apps/frontend/src/expense/**`) sits on top of the **job/document** aggregate and a deep approval engine:

- **Full lifecycle** — `apps/frontend/src/expense/enums/expenses.status.ts:11-19`: `OPEN → APPROVALS → APPROVED → REIMBURSED`, plus `REJECTED` and `UNREPORTED`. Status dropdown (`helper/StatusDropdown/constant.ts:11-78`) renders all five terminal/intermediate states with distinct iconography — i.e. every state is a *reachable, user-driven* transition.
- **Multi-level approval engine** — `libs/document/shapes/src/approval-policy.shape.ts`, `job-approver.shape.ts`, `approver-group.shape.ts`, `approval-progress-log.shape.ts`: approval **policies** (per-company, default, currency-scoped, archivable), **approver groups**, **thresholds** (`threshold_amount1/2`), **approval levels** (`approval_level`), dynamic approvers, and an **append-only progress log** (`approval-progress-log.shape.ts:7-19`) recording level entry/exit.
- **Multi-currency as a first-class concern** — `libs/document/shapes/src/currency-conversion-rates.shape.ts`: per-company conversion-rate table, a workspace/display currency, and `GetJobsCurrencyConversionRates` / `GetCurrencyConversionRateByCurrency` to **roll mixed-currency line amounts up into a single display currency**. Conversion is applied at report/job total time, not assumed-uniform.
- **Reimbursable flag** at the header/item level — `modules/.../ExpenseDetails/Properties/Properties.tsx:173-181` (`reimbursable`, `billable` checkboxes).
- **Comment thread + activity feed** as user-facing surfaces (comment sidebar, activity components throughout `modules/ExpenseDetails`).

## Our approach (Aegis)

A tight, single-level header-state-machine service. Schema is genuinely strong and reference-faithful at the structural level:

- `0003_expense.ts` — six tenant-scoped tables (`expense_categories`, `expense_reports`, `expenses`, `expense_approvals`, `expense_comments`, `expense_activities`), each with FORCE/RESTRICTIVE RLS, CHECK constraints on `status`/`decision`/`activity_type`, non-negative money CHECKs, per-tenant unique `report_number`, paranoid soft-delete + audit columns on the long-lived aggregates. Money in BIGINT minor units. This is correct and well-reasoned.
- `services/expense.service.ts` — role-keyed transition maps (submitter/manager/finance), `withTenantTransaction` RLS wrapping, activity-row writes, domain events, AuditLogger, and a pluggable ERP push on approval.

The **schema and the declared lifecycle match the reference**. The **service implementation does not finish it.**

---

## Divergences

### D1 — `reject` transition is declared everywhere but unimplemented and unreachable (REGRESSION, high)

The Rejected state is fully modeled but has no code path to reach it:
- Declared: `ExpenseReportStatus.Rejected` (`expense.enum.ts:6`), `ExpenseReportStatusDisplay` (`:14`), `ExpenseActivityType.ReportRejected` (`:25`), `ExpenseDecision.Rejected` (`expense.constants.ts:32`), MANAGER map `Approvals → [Approved, Rejected]` (`expense.constants.ts:20`), SUBMITTER map `Rejected → Open` revise-and-resubmit (`:15`), DB CHECK accepts `rejected` (`0003_expense.ts` status check + `expense_approvals_decision_check`), and even a `NotificationType.ExpenseRejected` (`notification.enum.ts:11`).
- **Missing:** there is no `rejectReport()` in `services/expense.service.ts` (only `submitReport`/`approveReport`), no `/reports/:id/reject` route in `controllers/expense-report.controller.ts`, and no `ExpenseReportReject` permission in `access.enum.ts:26-30`. A manager can only ever Approve.

The reference's lifecycle treats Reject as a primary manager action (`StatusDropdown/constant.ts:71-77`). This is a regression: we shipped a state machine that can enter `Approvals` but cannot reject, leaving submitters with no path back to `Open` (the `Rejected → Open` SUBMITTER edge is also unreachable). **Fix: add reject permission + route + service method (write an `expense_approvals` row with `decision=rejected`, `ReportRejected` activity, emit `ExpenseRejected`).**

### D2 — `reimburse` transition declared but unimplemented and unreachable (REGRESSION, high)

The reference's terminal happy-path state is `REIMBURSED` (`expenses.status.ts:5`, `StatusDropdown/constant.ts:42-49`). In Aegis:
- Declared: `ExpenseReportStatus.Reimbursed` (`expense.enum.ts:7`), `ExpenseActivityType.ReportReimbursed` (`:26`), FINANCE map `Approved → [Reimbursed]` (`expense.constants.ts:25`), DB CHECK accepts `reimbursed`.
- **Missing:** no `reimburseReport()` service method, no `/reports/:id/reimburse` route, no `ExpenseReportReimburse` permission, and — tellingly — **the `FINANCE` transition map and the `finance` role branch in `assertTransition` are dead code**: no role is ever passed `'finance'`, and the seeded `FinanceDisburser` role (`0001_system_roles.ts:36`) gets only payroll permissions, not any expense permission. The state machine has an unreachable terminal state. **Fix: add reimburse permission, grant it to a finance role, add the route + service method recording reimbursement.**

### D3 — `recall` (submitter pull-back) declared but unreachable (REGRESSION, medium)

SUBMITTER map declares `Approvals → Open` ("recall", `expense.constants.ts:16`) but there is no `recallReport()` method or route. A submitter who mis-submits cannot pull the report back, and (per D1) a manager cannot reject it either — so a report in `Approvals` with no implemented manager action is effectively wedged unless an Admin force-transitions it. **Fix: add a recall route/method using the already-declared edge.**

### D4 — Comment thread modeled end-to-end but has no endpoint (MISSING/REGRESSION, medium)

`expense_comments` table exists (`0003_expense.ts`), `ExpenseReportRepository.createComment()` is implemented (`expense-report.repository.ts`), `ExpenseActivityType.CommentAdded` is declared (`expense.enum.ts:27`), `ExpenseCommentRow` is in the shared shape — but **no service method and no controller route ever call `createComment`**. The reference surfaces comments as a primary collaboration feature (comment sidebar). We built the storage and left it orphaned. **Fix: add `addComment()` + `POST /reports/:id/comments`, or remove the dead table/repo method if out of scope.**

### D5 — No report-detail read (expenses / activities / approvals / comments) (MISSING, medium)

`GET /reports/:id` (`expense-report.controller.ts:77`) returns only the bare report header DTO (`toReportDto`). There is **no way to read a report's expense items, its activity feed, its approval decisions, or its comments** over the API — even though `ExpenseRepository.listExpensesForReport` exists and is used internally by the ERP push. The reference's entire `ExpenseDetails` module is built around showing items + activity + comments together. An approver literally cannot see what they are approving. **Fix: expand the detail response (or add sub-resource GETs) to include items, activities, approvals, comments.**

### D6 — Mixed-currency report total is summed without conversion or guard (REGRESSION, medium)

`recomputeReportTotal` (`expense-report.repository.ts`) does `Expense.sum('amount', { where: { report_id } })` — a raw BIGINT sum across all attached expenses **regardless of each item's `currency`**. Items carry a per-row `currency` (`0003_expense.ts` `expenses.currency`), `attachExpenseToReport` lets an item default to its own currency, and nothing validates that an item's currency equals the report's currency. Result: attaching a 100-EUR item and a 100-USD item to a USD report yields `total_amount = 200 USD`, silently wrong, and this wrong number is what gets pushed to the ERP (`pushToErp` sends `totalAmount`). The reference treats cross-currency rollup as a core problem (`currency-conversion-rates.shape.ts`, `GetJobsCurrencyConversionRates`). Header-level scope does NOT excuse summing unlike currencies. **Fix (header-level, minimal): reject attaching an item whose currency ≠ report currency (a CHECK/validation), OR apply conversion. The validation guard is the S-effort correct fix; do not silently mis-sum.**

### D7 — ERP push runs outside the report's transaction; partial-failure window (REGRESSION, low/medium)

In `approveReport` the status flip to `Approved` + approval row + activity + audit all commit in one `withTenantTransaction`, and **then** `pushToErp` runs *after* the transaction closes (`expense.service.ts` — `const result = await withTenantTransaction(...)` then `await this.pushToErp(...)`). If the process dies between commit and push, the report is `Approved` but never synced and **nothing retries** (the push is fire-and-forget on the request path; `synced_at` stays null with no reconciler). The idempotencyKey makes a *manual* retry safe, but there is no automatic outbox/retry. The reference drives ERP/integration sync via background consumers (`apps/background`, topic consumers), not inline on the request. **Fix: move the ERP push to an outbox/event consumer (an `ExpenseApproved` event is already emitted — consume it), so sync is durable and retried.**

### D8 — Single-level approval vs the reference's policy/threshold/multi-level engine (JUSTIFIED, low)

Aegis hardcodes `level: 1` (`expense.service.ts` `createApproval`) and a single manager approval. The reference has approval policies, approver groups, per-amount thresholds, N-level chains, and progress logs. For a **header-level** access-control platform this simplification is **justified** and defensible — the `expense_approvals.level` column and the role-keyed maps leave a clean extension seam. No action required, but note it as a deliberate scope boundary, not an oversight. (If multi-level is ever needed, the schema already supports it.)

### D9 — No `reimbursable` / `billable` header flag (JUSTIFIED, low)

The reference has `reimbursable`/`billable` checkboxes (`Properties.tsx:173-181`). Aegis omits them. For a generic expense-reimbursement state machine, "billable" (client-rebill) is genuinely out of scope, and "reimbursable" is implied (the whole report is a reimbursement). **Justified.** Optionally add a `reimbursable` boolean later if non-reimbursable corporate-card expenses must be tracked; not required now.

---

## Net assessment

The **schema is excellent and reference-faithful** — it models the *entire* lifecycle (all five states, approvals with levels, comments, activity feed) correctly, with strong RLS/CHECK/audit discipline. The problem is the **service layer implemented roughly half of what the schema and constants promise.** Three declared lifecycle transitions (reject, reimburse, recall) and one whole entity (comments) are unreachable, and the report-detail read is too thin for an approver to act. These are **regressions**, not justified scope cuts, because the supporting schema, enums, transition maps, notification types, and repository methods were all built — only the wiring is absent. The currency-sum bug (D6) and the non-durable ERP push (D7) are correctness issues that matter at header level. The multi-level approval and billable-flag omissions (D8/D9) are correctly **justified** under header-level scope.

**Priority order to close:** D1 (reject) → D2 (reimburse) → D6 (currency sum guard) → D5 (report detail) → D4 (comments) / D3 (recall) → D7 (durable ERP sync).
