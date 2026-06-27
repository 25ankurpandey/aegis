# Constants Hygiene Audit (SPEC §11.2)

**Scope:** SPEC §11.2 — *domain types/enums/constants belong in `libs/shared/*`*. This audit
catalogs constants declared **outside** `libs/shared` that should be centralized in a shared enum,
derived from an existing shared enum, or are justified as service-local wiring.

**Method:** read of every `apps/cli/src/migrations/*.ts`, `apps/*/src/**`, cross-checked each
hardcoded value set against the matching enum in `libs/shared/enums/src` and the column's type in
`libs/shared/types/src/*.shape.ts`. Evidence is `file:line`.

---

## 1. Summary

The migration layer is the only meaningful offender. Two patterns coexist in
`apps/cli/src/migrations`:

- **Good (derive-from-enum):** most CHECK constraints already do
  `Object.values(TheEnum)` against a `@aegis/shared-enums` import — e.g. `0002_invoice.ts:34-35`,
  `0005_payroll.ts:57,307,313,408,440,466,497`, `0001_identity.ts:118,187`, `0012_approvals.ts`,
  `0003/0006/0014/0019`. These are the reference pattern; no action.
- **Bad (hardcoded string array):** a handful of CHECK value sets are inline `as const` arrays.
  The migration author flagged these honestly in a header comment — `0005_payroll.ts:44-47`:
  *"Value sets for columns whose domain is a free-form string in the shapes (no dedicated enum)."*
  That comment **is the finding**: these domains never got a shared enum, so the shape types them as
  `string` (e.g. `payroll.shape.ts:19 employment_status: string`, `:98 rule_type: string`,
  `user-management.shape.ts:20 status: string`) and the literal strings are re-typed at every
  service write site. SPEC §11.2 says the enum should live in `libs/shared/enums` and **both** the
  migration CHECK and the shape should consume it.

Net: **10 hardcoded const arrays** across 4 migrations. **1** of them exactly duplicates an existing
shared enum (derive immediately). **9** have **no** matching enum and should get one (then derive).
`PUBLIC_PATHS` and `VAR_BUILDERS` are correctly service-local.

---

## 2. Catalog

| Location (file:line) | Constant | Duplicates which shared enum? | Recommendation |
|---|---|---|---|
| `apps/cli/src/migrations/0002_invoice.ts:37` | `INVOICE_APPROVAL_DECISION_VALUES = ['approved','rejected']` | **YES** — `ApprovalDecision` (`approval.enum.ts:44-47`, values `approved`/`rejected`) | **derive-from-enum**: `Object.values(ApprovalDecision)` (import already-exported enum) |
| `apps/cli/src/migrations/0002_invoice.ts:36` | `INVOICE_DUPLICATE_STATUS_VALUES = ['flagged','confirmed','dismissed','resolved']` | No (invoice.enum has Status/Txn/Activity, no DuplicateStatus). Service writes `'flagged'` raw at `invoice.repository.ts:151` + `invoice-duplicate.model.ts:21` | **move-to-shared**: add `InvoiceDuplicateStatus` enum → derive here + type `invoice-duplicate` shape |
| `apps/cli/src/migrations/0001_identity.ts:41` | `TENANT_STATUSES = ['active','suspended','cancelled','provisioning']` | No (identity.enum has UserStatus/InviteStatus/SessionStatus, no TenantStatus). Shape: `user-management.shape.ts:20 status: string` | **move-to-shared**: add `TenantStatus` enum → derive + type the tenant shape |
| `apps/cli/src/migrations/0007_reporting.ts:28` | `REPORT_RUN_STATUSES = ['queued','running','succeeded','failed']` | No — **there is no `reporting.enum.ts` at all** (not in `enums/src/index.ts`). Service writes `'queued'`/`'succeeded'` raw at `reporting.service.ts:94,104,112,166`; default at `report-run.model.ts:21` | **move-to-shared**: create `reporting.enum.ts` w/ `ReportRunStatus` → derive + type `RunStatusDto.status` (`reporting.shape.ts:172`) |
| `apps/cli/src/migrations/0005_payroll.ts:49` | `EMPLOYMENT_STATUSES = ['active','on_leave','suspended','terminated']` | No. Shape `payroll.shape.ts:19 employment_status: string`; raw write `employee.model.ts:17` + `employee.service.ts:30` | **move-to-shared**: add `EmploymentStatus` to `payroll.enum.ts` → derive + type shape |
| `apps/cli/src/migrations/0005_payroll.ts:51` | `CONTRACT_TYPES = ['salaried','hourly','contractor']` | No. Raw default `employment-contract.model.ts:18` | **move-to-shared**: add `ContractType` enum |
| `apps/cli/src/migrations/0005_payroll.ts:53` | `PAY_FREQUENCIES = ['weekly','biweekly','semimonthly','monthly','quarterly','annual','one_time']` | No. Used by 3 columns (pay_calendars/employment_contracts/employee_pay_items) — high reuse | **move-to-shared**: add `PayFrequency` enum (highest reuse → highest value) |
| `apps/cli/src/migrations/0005_payroll.ts:55` | `PAYSLIP_STATUSES = ['draft','calculated','approved','paid','reversed']` | No (distinct from `PayRunStatus` which has `funding`; payslip has no `funding`). Raw write `pay-run.service.ts:142,160` | **move-to-shared**: add `PayslipStatus` enum |
| `apps/cli/src/migrations/0005_payroll.ts:59` | `PAYSLIP_LINE_SOURCES = ['base','recurring','expense','bonus','adjustment','tax']` | **Near-dup** of `PayItemSource` (`payroll.enum.ts:23-29`: base/recurring/expense/bonus/adjustment) **+ `tax`**. Superset, not exact | **move-to-shared** (preferred): add `tax` to `PayItemSource` then derive; OR add a distinct `PayslipLineSource` enum if `tax` must not be a valid pay-item source. Decide intent first. |
| `apps/cli/src/migrations/0005_payroll.ts:61` | `SETTLEMENT_MODES = ['cyclic','immediate','off_cycle']` | No | **move-to-shared**: add `SettlementMode` enum |
| `apps/cli/src/migrations/0005_payroll.ts:63` | `TAX_RULE_TYPES = ['income_tax','social_security','medicare','unemployment','flat','bracket']` | No. Shape `payroll.shape.ts:98 rule_type: string` | **move-to-shared**: add `TaxRuleType` enum |
| `apps/user-management/src/bootstrap.ts:16-23` | `PUBLIC_PATHS` (infra paths + this service's own `/auth/register`,`/auth/login`) | n/a — not a domain value set; built from `ApiConstants.PublicPrefix` | **justified-local**: composition-root wiring for *this* service's PEP. Not a cross-service domain constant. Leave. |
| `apps/notification/src/services/content-map.ts:62` | `VAR_BUILDERS` (mapped type keyed by `NotificationCode`) | n/a — behavior map keyed *by* an enum, not a value list | **justified-local**: type-safe per-code template/var builders (functions). Leave. |
| `apps/cli/src/migrations/0022_record_team_tags.ts:16` | `TABLES = [TableName.ExpenseReports, TableName.Invoices, TableName.PayRuns]` | n/a — already built from `TableName` enum | **justified-local**: a migration-local selection of enum members, not a duplicated literal set. Leave. |

---

## 3. Notes on the "no matching enum" cases

For all nine "move-to-shared" rows the right fix is **not** to derive against an enum that doesn't
exist — it is to **create the enum in `libs/shared/enums`** (per SPEC §11.2), then:

1. migration CHECK derives via `Object.values(NewEnum)`,
2. the matching `*.shape.ts` field narrows from `string` → `NewEnum`,
3. service write sites stop using raw string literals (`employee.model.ts:17`,
   `reporting.service.ts:94`, `invoice.repository.ts:151`, etc.) and use the enum member.

This is one connected change per domain, not three independent edits — the value of centralizing is
that the CHECK, the DTO type, and the writers all reference one source of truth. The migration's own
header comment (`0005_payroll.ts:42-47`) already acknowledges the arrays are a stand-in for missing
enums.

Scope note (our use case): all nine are core to expense/invoice/payroll records + the approval
engine, so all are worth doing — none are reference-only frontend concerns we can skip.

---

## 4. Prioritized fix list (for the implementation lane)

**P0 — trivial, pure win (derive against an enum that already exists):**

1. `0002_invoice.ts:37` `INVOICE_APPROVAL_DECISION_VALUES` → `Object.values(ApprovalDecision)`
   (add `ApprovalDecision` to the `@aegis/shared-enums` import already on `0002:3`). Delete the array.

**P1 — high reuse / multiple raw write sites (create enum, derive, narrow shape, fix writers):**

2. `PayFrequency` (3 columns; `0005:53`) — biggest blast radius.
3. `EmploymentStatus` (`0005:49`; writers `employee.model.ts:17`, `employee.service.ts:30`).
4. `PayslipStatus` (`0005:55`; writer `pay-run.service.ts:142,160`).
5. `ReportRunStatus` — **also create `libs/shared/enums/src/reporting.enum.ts` + add to
   `enums/src/index.ts`** (`0007:28`; writers `reporting.service.ts:94,104,112,166`,
   `report-run.model.ts:21`; narrow `reporting.shape.ts:172`).
6. `InvoiceDuplicateStatus` (`0002:36`; writers `invoice.repository.ts:151`,
   `invoice-duplicate.model.ts:21`).
7. `TenantStatus` (`0001:41`; narrow `user-management.shape.ts:20`).

**P2 — lower reuse, finish the set:**

8. `ContractType` (`0005:51`; default `employment-contract.model.ts:18`).
9. `TaxRuleType` (`0005:63`; narrow `payroll.shape.ts:98`).
10. `SettlementMode` (`0005:61`).
11. `PayslipLineSource` (`0005:59`) — **decision required first**: extend `PayItemSource` with `tax`
    and reuse it, or introduce a separate enum. Do not blindly derive; the `tax` value is the only
    delta from the existing `PayItemSource`.

**No-ops (documented, do not change):** `PUBLIC_PATHS` (bootstrap.ts), `VAR_BUILDERS`
(content-map.ts), `TABLES` (0022), and every existing `Object.values(...)` CHECK.
