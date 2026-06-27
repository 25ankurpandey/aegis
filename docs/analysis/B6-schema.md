# B6 — Schema Comprehensiveness & Scale-Robustness Audit (Aegis vs the domain reference)

**Track:** B (domain-reference completeness) · **Area:** schema comprehensiveness + scale-robustness
**Auditor stance:** skeptical, evidence-first. The reference codebases are READ-ONLY.
**Reference (domain):** the domain reference — a real production enterprise AP/invoice/job platform with **709 migrations** (`libs/document/migrations/src/migrations/`) and **136 models** (`libs/document/models/src/`).
**Ours:** `/Users/ankurpandey/Documents/GitHub/aegis/apps/cli/src/migrations/` (10 migrations, 0001–0010) + per-service enriched models under `apps/*/src/models/`.

---

## TL;DR verdict

Aegis's schema is **architecturally cleaner and in several respects MORE disciplined than the domain reference** (consistent CHECK constraints, per-FK covering indexes, money-as-minor-units with non-negative CHECKs, idempotency keys, RLS FORCE+RESTRICTIVE on every table). The reference, being 709 organically-grown migrations, is messier.

**BUT** there are three real, confirmed schema defects that will bite at enterprise scale, and the most damning part is that **Aegis's own authors demonstrably knew the correct pattern and applied it inconsistently** — the partial-unique-index fix exists in exactly one table (`Rules`) and is missing from six others. This is not a "we never learned the pattern" gap; it is an inconsistency/regression that a careful reviewer must close.

| # | Finding | Class | Severity |
|---|---------|-------|----------|
| a | Paranoid (soft-delete) tables use **PLAIN** unique indexes instead of **PARTIAL** `WHERE deleted_at IS NULL` | regression | **critical** |
| b | **Zero** optimistic-locking/`version: true` columns across all 14 paranoid models | missing | high |
| c | Missing/weak indexes for real query patterns (invoice_number dedup, partial indexes on `active`, trigram search) | mixed | medium |
| d | Tenant-scoping of unique constraints — **actually correct**, matches reference | justified | — |

---

## (a) CONFIRMED BUG — paranoid tables with PLAIN unique indexes  ·  **regression · critical**

### Reference evidence (the correct pattern)
the domain reference consistently expresses "unique among *live* rows" as a **PARTIAL unique index**:

- `0509_unique_idx_on_gl_cde_name.ts:11-19` — `addIndex('gl_codes', { fields: ['gl_code','is_combination','company_id'], unique: true, where: { active: true, is_combination: true } })`
- `0258_gl_codes_ukey.ts:14-16` — raw `CREATE UNIQUE INDEX ... ON job_gl_codes (job_id) WHERE job_line_item_id IS NULL;`
- `0337_update_gl_codes_ukey_index.ts:13-15` — `CREATE UNIQUE INDEX ... (job_id, gl_code_id) WHERE job_line_item_id IS NULL;`

The reference's soft-delete columns are `deleted_at` (`0332_job_comment_deleted_at.ts:9-12`), and its uniqueness is repeatedly scoped to live rows via `WHERE ... IS NULL` / `WHERE active = true`.

### Our evidence (the bug)
Aegis declares paranoid soft-delete via `softDelete = { deleted_at }` and `paranoid: true, deletedAt: 'deleted_at'` in the models (e.g. `apps/user-management/src/models/user.model.ts:23`, `tenant.model.ts:20`, `role.model.ts:21`; `apps/payroll/src/models/employee.model.ts:27`; `apps/invoice/src/models/invoice.model.ts:36`). 14 models declare `paranoid: true`.

**The authors KNEW the pattern** — they applied it correctly exactly once:
- `apps/cli/src/migrations/0004_workflow.ts:61-65` — `addIndex(Rules, ['tenant_id','name'], { unique: true, where: { deleted_at: null } })` ✅ with the comment *"A rule name is a tenant-unique natural key (ignoring soft-deleted rows)."*

Every other soft-delete table got a **PLAIN** unique index (no `where`), so a `destroy()` (soft delete) leaves the row occupying the unique slot — re-creating an entity with the same natural key fails with a duplicate-key violation:

| Table | Soft-delete? | Plain unique index | File:line |
|-------|-------------|--------------------|-----------|
| Users | yes (`user.model.ts:23`) | `users_tenant_email_uq` on `(tenant_id, email)` | `0001_identity.ts:82` |
| PayCalendars | yes (`...softDelete` `0005:149`) | `pay_calendars_tenant_name_uq` on `(tenant_id, name)` | `0005_payroll.ts:152` |
| EarningCodes | yes (`0005:169`) | `earning_codes_tenant_name_uq` on `(tenant_id, name)` | `0005_payroll.ts:172` |
| DeductionCodes | yes (`0005:183`) | `deduction_codes_tenant_name_uq` on `(tenant_id, name)` | `0005_payroll.ts:186` |
| ExpenseCategories | yes (`0003:54`) | `expense_categories_tenant_code_uq` on `(tenant_id, code)` | `0003_expense.ts:58-62` |
| ExpenseReports | yes (`0003:83`) | `expense_reports_tenant_number_uq` on `(tenant_id, report_number)` | `0003_expense.ts:86-89` |

> Note: `Tenants.slug` (`0001:54`) and `Roles` (paranoid) also carry plain uniqueness; `Tenants` is paranoid (`tenant.model.ts:20`) so `slug` has the same defect. `Roles` has no name-unique index at all (`roles_tenant_name_idx` is non-unique `0001:111`) so it is *not* affected by (a) but is a separate looseness.

**Impact at scale:** the moment a tenant soft-deletes a user/pay-calendar/earning-code/expense-category and tries to re-create one with the same email/name/code (an extremely common enterprise flow), the insert throws a 23505 unique violation. It is also **reference-infidelity**: the reference never makes this mistake.

**Fix:** re-create each as a partial unique index, matching the one correct case (`0004_workflow.ts:64`). For tables where the soft-deleted row must still satisfy a *separate* uniqueness (rare here), add a second non-unique index. Because these are paranoid tables, the existing plain index must be **dropped first** then re-created `WHERE deleted_at IS NULL` (do it in a new forward migration, e.g. `0011_partial_unique_indexes.ts`, never by editing 0001–0005).

---

## (b) Missing optimistic-locking / version columns  ·  **missing · high**

### Reference evidence
the domain reference does carry explicit version columns where concurrent edits matter — `0388_auditlog_migration.ts:11-15` adds `rule_version INTEGER NOT NULL DEFAULT 0` and indexes it (`0507_add_missing_indexes_in_rule_audit_logs.ts:10`). `service-agreement.model.ts:7,33` and `job-approver.model.ts` carry `version`. The reference mostly relies on row-level locking + status state machines, but it tracks versions on the entities that get concurrently mutated.

### Our evidence
**No table uses Sequelize optimistic locking.** `libs/db/src/base-model.ts:19-24` (`baseModelOptions`) sets `underscored/timestamps/createdAt/updatedAt` but **not** `version: true`. A repo-wide `grep 'version: true'` returns **zero** hits.

The only `version` column is `tax_rules.version` (`0005_payroll.ts:198`, model `apps/payroll/src/models/tax-rule.model.ts:22`) and it is a **domain effective-dating version**, not an optimistic-lock counter (it's `defaultValue: 1` with a `>= 1` CHECK, never incremented on write).

**Impact at scale:** every status-machine entity (`Invoices`, `ExpenseReports`, `PayRuns`, `Rules`) is mutated via read-modify-write across concurrent approvers/workers with **no lost-update protection**. Two approvers acting on the same invoice can silently clobber each other. This is a classic enterprise concurrency hole the reference partially guards against.

**Fix:** add `version: true` to `baseModelOptions` (Sequelize then maintains an integer `version` column and adds a `WHERE version = ?` guard on every UPDATE, throwing `OptimisticLockError` on conflict) — but this requires a `version INTEGER NOT NULL DEFAULT 0` column on every model table via migration. Pragmatic scoping: add it to the **mutable aggregate roots with state machines** first — `Invoices`, `ExpenseReports`, `PayRuns`, `Rules`, `Employees`, `Roles`, `Users` — not the append-only `*_activities` tables.

---

## (c) Missing / weak indexes for the actual query patterns  ·  **mixed**

Aegis is generally **good** here — it adds per-FK covering indexes deliberately (`0001:122` `role_perm_permission_idx`, `0001:134` `user_roles_role_idx`, `0002:143` `invoice_dup_duplicate_of_idx`) with comments showing the author reasoned about FK coverage. But three gaps stand out vs reference practice:

1. **`invoices.invoice_number` has no uniqueness or dedicated index** (`0002_invoice.ts:50`). The reference explicitly indexes its analog: `0268_job_invoice_info_index_on_company_id_invoice_number.ts` indexes `(company_id, invoice_number)` and generates sequential numbers via a PL/pgSQL function (`0024_add_job_number_column.ts`). Aegis's only invoice-number coverage is buried inside the composite `invoices_dup_signature_idx (tenant_id, vendor_name, invoice_number, amount_minor)` (`0002:72`), which cannot serve a `(tenant_id, invoice_number)` lookup or enforce per-vendor invoice-number uniqueness. **Class: missing · medium.** Recommend `addIndex(Invoices, ['tenant_id','vendor_id','invoice_number'])` (and consider a partial-unique for true dedup once business rules are confirmed).

2. **No partial indexes keyed on `active`/`is_active` for hot list paths.** The reference's hot lists are indexed *on the active flag*: `0547_add_provider_indexes.ts:9-11` `idx_providers_company_active_name ON providers(company_id, active, name)`. Aegis has `is_active`/`active` columns (`ExpenseCategories.is_active 0003:51`, `InvoiceApprovals.active 0002:165`, `Rules.active`) but most list indexes are `(tenant_id, status)` / `(tenant_id, created_at)` and don't include the active flag, so "list active X" scans+filters. **Class: missing · low–medium.** Add `(tenant_id, active, …)` partial or composite indexes where the dominant query filters on active.

3. **No trigram / search indexes.** Reference ships `0551_add_trigram_indexes_on_users.ts` (`pg_trgm` GIN on `users.first_name/last_name`) for name search. Aegis has no equivalent on `Users`, `Employees`, `vendor_name`, etc. **Class: missing · low** (only matters once a search/typeahead feature exists — flag, don't pre-build).

4. **JSONB columns have no GIN indexes.** `tax_rules.params` (`0005:197`), `pay_runs.locked_snapshot` (`0005:266`), `*_activities.details` (`0002:193`) are `JSONB` with no GIN index. Acceptable *if* never queried by content; the reference only GIN-indexes JSONB it actually filters on. **Class: justified-for-now · low** — revisit if any JSONB field becomes a filter predicate.

> **What Aegis does BETTER than reference (justified divergences worth recording):**
> - CHECK constraints on every status/enum + non-negative money (`amount_minor >= 0`, `0002:88-93`) — reference relies on app-level enums far more loosely.
> - Idempotency keys with unique indexes: `payroll_inputs_idempotency_uq` (`0005:375`), `payments_idempotency_uq` (`0005:432`) — the reference has **no** `idempotency_key` columns at all (grep returned zero). This is a genuine enterprise-grade improvement.
> - RLS `FORCE` + `RESTRICTIVE` policies on every table (`0001:43-46`, `rlsPolicyStatements`) — stronger tenant isolation than the reference's app-layer `company_id` filtering.
> - Money as `BIGINT` minor units everywhere — reference mixes representations.

---

## (d) Tenant-scoping of unique constraints  ·  **justified (matches reference)**

**No defect.** Every Aegis natural-key uniqueness is correctly tenant-prefixed: `(tenant_id, email)`, `(tenant_id, name)`, `(tenant_id, report_number)`, `(tenant_id, code)`. This mirrors the reference exactly, which scopes uniqueness by its tenant key `company_id`: `0555_add_unique_constraint_to_locations.ts:6` `(company_id, external_id)`, `0277_app_page_settings_constraint.ts:25` `(company_id, user_id)`, `0509:13` includes `company_id`. The platform-default pattern (nullable `tenant_id` = seeded default, custom RLS) in `tax_rules`/`Roles` (`0005:192`, `0001:103,146`) is a sound adaptation. **Verdict: justified — the only thing to fix is layering the `deleted_at IS NULL` predicate on top (finding a), not the tenant-scoping itself.**

> One sub-note: `Employees` has **no natural-key uniqueness at all** (only `employees_tenant_idx`, `0005:93`) — no unique `(tenant_id, person_ref)` or employee number. The reference relies on app-generated numbers; whether Aegis needs one depends on whether `person_ref` must be unique per tenant. Flag for product decision, not an automatic fix.

---

## Concrete schema-hardening list (priority order)

New forward migration(s) only — never edit 0001–0010.

1. **[critical] `0011_partial_unique_indexes.ts`** — drop + re-create as `WHERE deleted_at IS NULL` partial unique indexes: `users_tenant_email_uq`, `pay_calendars_tenant_name_uq`, `earning_codes_tenant_name_uq`, `deduction_codes_tenant_name_uq`, `expense_categories_tenant_code_uq`, `expense_reports_tenant_number_uq`, and `Tenants.slug`. Use `0004_workflow.ts:61-65` as the template. (effort: M)
2. **[high] `0012_optimistic_locking.ts` + base-model change** — add `version INTEGER NOT NULL DEFAULT 0` to the mutable aggregate roots (`Invoices`, `ExpenseReports`, `PayRuns`, `Rules`, `Employees`, `Users`, `Roles`); set `version: true` (mapped to that column) in the corresponding model options. (effort: L)
3. **[medium] invoice-number index** — `addIndex(Invoices, ['tenant_id','vendor_id','invoice_number'])`; decide with product whether it should be partial-unique for dedup. (effort: S)
4. **[low-med] active-flag list indexes** — add `(tenant_id, active, …)` composite/partial indexes on the hot list paths that filter by `active`/`is_active` (mirroring reference `0547`). (effort: S)
5. **[low / deferred] trigram + JSONB GIN indexes** — only when a search or JSONB-filter feature actually lands (reference only indexes what it queries). (effort: S each)

---

## Honest bottom line for the owner

The owner's doubt is **partly justified and partly not**. The refactor did *not* blindly copy the reference — and in the areas it diverged on purpose (CHECK constraints, idempotency keys, RLS FORCE/RESTRICTIVE, BIGINT money) it is **better** than the domain reference. But it shipped one genuine **critical regression** (the soft-delete partial-index bug, made worse by the fact that the team clearly knew the fix and applied it to only one table) and one real **enterprise gap** (no optimistic locking anywhere). Those two, plus the invoice-number index, are the must-fix list; everything else is "build when the feature needs it."
