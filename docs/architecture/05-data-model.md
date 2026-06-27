# 05 — Data Model

> **Source of truth:** `apps/cli/src/migrations/0001_*.ts … 0022_*.ts` (registered in
> `apps/cli/src/migrations/index.ts`). Every table, column, FK, index, CHECK and RLS policy below is
> derived strictly from those migrations and the RLS helper in `libs/db/src/rls.ts`. The migrations
> consume `@aegis/shared-enums` (table names + enum value sets) and `@aegis/shared-constants`
> (`RlsConstants` session-variable names).

The schema is a **single PostgreSQL database**, multi-tenant by row, isolated by **Row-Level
Security**. PKs are UUID v4 (`gen_random_uuid()`) except the Casbin policy store (serial int) and the
Sequelize migration bookkeeping table. Money is stored as **BIGINT minor units**. Every business
table that carries a `tenant_id` is RLS-guarded with a **FORCE + RESTRICTIVE** policy keyed on the
transaction-local session variable `app.current_tenant`.

---

## 1. Multi-tenancy & Row-Level Security

### 1.1 The standard policy (`rlsPolicyStatements`)

`libs/db/src/rls.ts` emits the same four statements for every tenant-keyed table. The policy name is
always `<table>_tenant_isolation`:

```sql
ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;          -- applies even to the table owner
DROP POLICY IF EXISTS "<table>_tenant_isolation" ON "<table>";
CREATE POLICY "<table>_tenant_isolation" ON "<table>"
  AS RESTRICTIVE                                          -- ANDs with any other policy; cannot be OR'd away
  USING      (tenant_id = current_setting('app.current_tenant', true)::uuid)   -- READ predicate
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);  -- WRITE predicate
```

Key properties (all load-bearing, all from the code):

- **`FORCE ROW LEVEL SECURITY`** — RLS applies even to the table-owning role; there is no
  "owner bypass". RLS is never circumvented for ordinary access.
- **`AS RESTRICTIVE`** — the tenant guard is AND-combined with every other policy, so a future
  permissive policy can never OR it away.
- **READ vs WRITE split** — `USING` controls which rows are visible; `WITH CHECK` controls which rows
  may be inserted/updated. By default they are identical. They diverge only where a table must let a
  tenant _read_ a global row it must not _write_ (see §1.3).
- **`current_setting('app.current_tenant', true)`** — the `true` ("missing_ok") second arg means a
  session with no tenant set yields `NULL`, so the predicate fails closed (no rows) rather than
  erroring. Casting `::uuid`.

### 1.2 Setting the tenant context per transaction (`setTenantContext`)

```sql
SELECT set_config('app.current_tenant', :tenantId, true);   -- true = transaction-LOCAL (SET LOCAL)
SELECT set_config('app.current_user',   :userId,   true);   -- optional, when a principal is present
```

The third `true` argument makes the setting **transaction-local** (the `SET LOCAL` equivalent), which
is the critical detail for **transaction-mode connection pooling**: the tenant scope is bound to the
transaction, not the physical connection, so a pooled connection cannot leak one tenant's scope into
another tenant's next transaction.

Session variables (`libs/shared/constants/src/app.constants.ts → RlsConstants`):

| Constant         | Value                | Used by                                    |
| ---------------- | -------------------- | ------------------------------------------ |
| `TenantVar`      | `app.current_tenant` | every tenant-isolation policy              |
| `UserVar`        | `app.current_user`   | optional principal context                 |
| `OutboxRelayVar` | `app.outbox_relay`   | the outbox relay cross-tenant drain (§1.3) |

```mermaid
flowchart LR
  REQ["Request<br/>(tenantId, userId)"] --> TX["BEGIN tx"]
  TX --> SC1["set_config('app.current_tenant', tenantId, true)"]
  TX --> SC2["set_config('app.current_user', userId, true)"]
  SC1 --> Q["Business SQL"]
  SC2 --> Q
  Q --> RLS{"RESTRICTIVE policy<br/>tenant_id = current_setting(app.current_tenant)"}
  RLS -->|match| ROWS["visible / writable rows"]
  RLS -->|no match / unset| EMPTY["zero rows (fail-closed)"]
  Q --> COMMIT["COMMIT<br/>(SET LOCAL scope ends)"]
```

### 1.3 Exceptions to the standard policy

Three deviations exist, each created with a hand-written policy instead of the helper:

1. **Tables with a non-`tenant_id` isolation key.**
   - `tenants` (`0001`) — isolates on its own PK: `id = current_setting('app.current_tenant', true)::uuid`
     (helper `customRls`, RESTRICTIVE, no separate WITH CHECK).

2. **Tables that admit cross-tenant _reads_ of global rows but must restrict _writes_ (BUG-0009).**
   The `USING` predicate is wider than `WITH CHECK`:
   - `roles` (`0001`) — `tenant_id IS NULL` rows are platform-wide **system roles** every tenant may
     READ, but a tenant session may only WRITE its own tenant rows:
     - `USING`: `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', true)::uuid`
     - `WITH CHECK`: `tenant_id = current_setting('app.current_tenant', true)::uuid`
   - `tax_rules` (`0005`) — `tenant_id IS NULL` rows are seeded **platform-default** tax rules visible
     to all tenants; `customRls` here applies the wide predicate to USING (and, since `customRls` in
     `0005` passes no separate WITH CHECK, Postgres defaults WITH CHECK to USING — note this is a
     looser write predicate than `roles`).

3. **The outbox relay bypass.**
   - `event_outbox` (`0011`) — predicate is
     `(tenant_id = current_setting('app.current_tenant', true)::uuid) OR current_setting('app.outbox_relay', true) = 'on'`
     for **both** USING and WITH CHECK. Only the relay sets `app.outbox_relay = 'on'` (via `SET LOCAL`),
     letting one poll drain every tenant's backlog; normal sessions never set it and stay strictly
     isolated.

4. **Append-only hardening at the database (defense in depth).**
   - `ledger_entries` (`0005`) — in addition to the tenant policy, two extra RESTRICTIVE policies make
     the table physically append-only: `FOR UPDATE USING (false)` and `FOR DELETE USING (false)`.

5. **Tables intentionally WITHOUT RLS.**
   - `casbin` (`0009`) — the Casbin policy catalog is **global infrastructure**, carries no
     `tenant_id`, and has **no RLS**. Tenant scoping lives _inside_ each policy row via the `dom`
     field (`dom = tenantId`), enforced by the Casbin matcher, not by Postgres.

### 1.4 Tenant-table inventory (RLS keying)

| Domain           | Tables with standard `tenant_id` RLS                                                                                                                                                                                            | Custom / no RLS                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| identity/access  | `users`, `user_roles`, `teams`, `team_members`, `tags`, `team_tags`, `record_tags`                                                                                                                                              | `tenants` (PK key), `roles` (wide-read/narrow-write), `permissions`/`role_permissions` (global, no tenant_id) |
| approvals engine | `approval_policies`, `approval_hierarchy`, `approver_groups`, `approver_group_members`, `record_approvers`, `approvals`                                                                                                         | —                                                                                                             |
| expense          | `expense_categories`, `expense_reports`, `expenses`, `expense_approvals`, `expense_comments`, `expense_activities`                                                                                                              | —                                                                                                             |
| invoice          | `invoices`, `invoice_metadata`, `invoice_duplicates`, `invoice_approvals`, `invoice_activities`                                                                                                                                 | —                                                                                                             |
| payroll          | `employees`, `employment_contracts`, `pay_calendars`, `earning_codes`, `deduction_codes`, `employee_pay_items`, `pay_runs`, `payslips`, `payslip_lines`, `payroll_input_items`, `payment_batches`, `payments`, `ledger_entries` | `tax_rules` (platform-default + tenant rows)                                                                  |
| workflow         | `rules`, `rule_steps`, `rule_actions`, `rule_audit_logs`                                                                                                                                                                        | —                                                                                                             |
| notification     | `notifications`, `email_notification_logs`, `notification_preferences`, `email_sender_identities`, `email_suppressions`                                                                                                         | —                                                                                                             |
| reporting        | `report_definitions`, `report_schedules`, `report_runs`, `report_access_policies`                                                                                                                                               | —                                                                                                             |
| connectors       | `connector_sync_state`                                                                                                                                                                                                          | —                                                                                                             |
| platform         | `audit_log`, `activity_log`, `event_outbox` (relay-bypass), `tenant_config`, `tenant_features`                                                                                                                                  | `casbin` (no RLS)                                                                                             |

`permissions` and `role_permissions` are **global catalog tables** — no `tenant_id`, no RLS; they are
linked to tenants only transitively through `roles`/`user_roles`.

---

## 2. Conventions (column-level patterns)

These reusable column groups appear across the migrations (defined as local `const` spreads):

| Convention                 | Columns                                                                     | Semantics                                                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UUID PK**                | `id UUID PK DEFAULT gen_random_uuid()`                                      | all business tables                                                                                                                                                                                                              |
| **Timestamps**             | `created_at`, `updated_at` (`DATE NOT NULL DEFAULT now()`)                  | mutable rows; append-only tables keep `created_at` **only**                                                                                                                                                                      |
| **Audit attribution**      | `created_by`, `updated_by` (`UUID NULL`)                                    | "who created / last mutated"; nullable for system/seed/back-fill writes                                                                                                                                                          |
| **Soft-delete (paranoid)** | `deleted_at DATE NULL`                                                      | Sequelize `paranoid: true`; `NULL` = live row                                                                                                                                                                                    |
| **Optimistic lock**        | `lock_version INTEGER NOT NULL DEFAULT 0`                                   | Sequelize `version: 'lock_version'`; bumped on each UPDATE with `WHERE lock_version = ?`, raising `OptimisticLockError` on a stale write. Named `lock_version` to avoid colliding with domain effective-dating `version` columns |
| **Money**                  | `*_minor` / `amount` / `gross` … `BIGINT`                                   | integer **minor units** (e.g. cents); CHECKed `>= 0`                                                                                                                                                                             |
| **Currency**               | `currency CHAR(3)` (invoice/expense) or `STRING` (payroll, default `'USD'`) | ISO 4217                                                                                                                                                                                                                         |
| **Idempotency key**        | `idempotency_key STRING` + UNIQUE index                                     | exactly-once semantics on side-effecting tables                                                                                                                                                                                  |
| **Tenant FK**              | `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`          | the RLS key                                                                                                                                                                                                                      |

### 2.1 Soft-delete + partial-unique

Because `paranoid` tables retain soft-deleted rows, every natural-key uniqueness is a **partial unique
index scoped to live rows** (`WHERE deleted_at IS NULL`), so a natural key (slug, email, role name,
report number, calendar/code name, pay-run period) can be reused after a soft-delete without hitting a
`23505` on recreate. Examples: `tenants_slug_uq`, `users_tenant_email_uq`, `roles_tenant_name_uq`
(+ `roles_system_name_uq` for `tenant_id IS NULL` system roles, since NULLs are distinct in a
composite unique index), `expense_reports_tenant_number_uq`, `pay_runs_tenant_period_uq`,
`approval_policies_tenant_type_name_uq`, `approver_groups_tenant_name_uq`.

### 2.2 Optimistic-lock carriers

`lock_version` is present on the mutable aggregate roots whose state machines admit concurrent writers:
`users`, `roles`, `invoices`, `expense_reports`, `rules`, `employees`, `pay_runs`.

### 2.3 Append-only tables (no `updated_at`, no soft-delete, no `lock_version`)

`audit_log`, `activity_log`, `event_outbox`, `invoice_activities`, `expense_activities`,
`rule_audit_logs`, `approvals`, `payments`, `ledger_entries` (DB-enforced via no-UPDATE/no-DELETE
policies), `email_suppressions`. `report_runs` is append-**once** (carries only `requested_by`, no
`updated_by`/`deleted_at`).

### 2.4 Hash-chained audit log

`audit_log` (`0008`) is **tamper-evident**: each row carries `prev_hash` and `hash` (both
`STRING NOT NULL`). Rows form a hash chain — `hash` is computed over the row's content plus the prior
row's `hash` (`prev_hash`), so any retroactive edit/deletion breaks the chain and is detectable. It
also stores `action`, `outcome`, `resource_type`/`resource_id`, `details` (JSONB) and the
`permissions` (JSONB array) evaluated for the action. (Note: `audit_log.tenant_id` is `NOT NULL` but
is **not** declared as an FK to `tenants` — it is a plain UUID, still RLS-keyed.)

### 2.5 Double-entry, append-only ledger

`ledger_entries` (`0005`) is a double-entry GL: each row has an unsigned `debit` and `credit`
(`BIGINT`, CHECK `>= 0`), an `account` (CHECKed to `LedgerAccount`), and a self-referential
`reversal_of` (a correction posts a **reversal** row, never an update/delete). The append-only
guarantee is enforced in SQL by the `FOR UPDATE USING (false)` / `FOR DELETE USING (false)` policies.

---

## 3. Domain ER diagrams

> Notation: `PK`/`FK`/`UK` marked where load-bearing. `(money)` = BIGINT minor units. Soft-delete
> tables are flagged in the table comment. Relationship labels read parent→child.

### 3.1 Identity & Access (`0001`)

`permissions` and `role_permissions` are **global** (no `tenant_id`). `roles.tenant_id` is nullable
(`NULL` = system role). `users`, `roles`, `tenants` are paranoid + optimistic-locked.

```mermaid
erDiagram
  tenants ||--o{ users : "has"
  tenants ||--o{ roles : "owns (nullable=system)"
  tenants ||--o{ user_roles : "scopes"
  users ||--o{ user_roles : "assigned"
  roles ||--o{ user_roles : "granted via"
  roles ||--o{ role_permissions : "grants"
  permissions ||--o{ role_permissions : "in"

  tenants {
    uuid id PK
    string name
    string slug "UK live: tenants_slug_uq"
    string status "CHK TenantStatus, default active"
    uuid created_by_updated_by
    date deleted_at "paranoid"
  }
  users {
    uuid id PK
    uuid tenant_id FK "RLS"
    string email "UK live (tenant_id,email)"
    string password_hash
    string status "CHK UserStatus, default active"
    int lock_version "optimistic"
    date deleted_at "paranoid"
  }
  permissions {
    uuid id PK
    string name UK "global, no tenant_id"
    string description
  }
  roles {
    uuid id PK
    uuid tenant_id FK "NULLABLE = system role"
    string name "UK live per tenant + system"
    bool is_system "default false"
    int lock_version "optimistic"
    date deleted_at "paranoid"
  }
  role_permissions {
    uuid id PK
    uuid role_id FK
    uuid permission_id FK
    string role_perm_uq "UK (role_id,permission_id)"
  }
  user_roles {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid user_id FK
    uuid role_id FK
    string scope "CHK Scope, default own_only; UK (tenant_id,user_id)"
  }
```

### 3.2 Approvals engine (`0012`, `0013`)

A shared, polymorphic multi-level engine keyed by `(record_type, record_id)`. `record_approvers` is
the resolved live chain (with supersede history added in `0013`); `approvals` is the immutable vote
ledger.

```mermaid
erDiagram
  tenants ||--o{ approval_policies : "configures"
  tenants ||--o{ approval_hierarchy : "manages"
  tenants ||--o{ approver_groups : "owns"
  approver_groups ||--o{ approver_group_members : "contains"
  tenants ||--o{ record_approvers : "resolves chain"
  tenants ||--o{ approvals : "vote ledger"

  approval_policies {
    uuid id PK
    uuid tenant_id FK "RLS"
    string record_type
    string name "UK live (tenant,type,name)"
    string mode "CHK ApprovalMode, default sequential"
    int min_approvals "CHK >=1, default 1"
    bool is_active
    jsonb config
    date deleted_at "paranoid"
  }
  approval_hierarchy {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid user_id "UK (tenant,user)"
    uuid manager_id "nullable"
    int depth "CHK >=0"
  }
  approver_groups {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name "UK live (tenant,name)"
    bool is_active
    date deleted_at "paranoid"
  }
  approver_group_members {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid group_id FK
    string member_type "CHK ApproverGroupMemberType (user|role)"
    uuid member_id
    string uq "UK (tenant,group,member_type,member_id)"
  }
  record_approvers {
    uuid id PK
    uuid tenant_id FK "RLS"
    string record_type
    uuid record_id
    int level "CHK >=1"
    string approver_type "CHK ApproverType, default user"
    uuid approver_id
    string status "CHK RecordApproverStatus, default pending"
    int sequence
    bool is_active "0013: live chain; default true"
    uuid superseded_by_id "0013: retired->replacement"
    string uq "UK live (tenant,type,id,level,approver) WHERE is_active"
  }
  approvals {
    uuid id PK
    uuid tenant_id FK "RLS"
    string record_type
    uuid record_id
    int level "CHK >=1"
    uuid approver_id
    string decision "CHK ApprovalDecision"
    text comment
    date decided_at
    date created_at "append-only (no updated_at)"
    string uq "UK (tenant,type,id,level,approver) no-double-vote"
  }
```

`record_approvers` and `approvals` reference business records polymorphically by
`(record_type, record_id)` — there is **no DB FK** to the underlying expense/invoice/pay-run rows;
the link is by convention enforced in the service layer.

### 3.3 Record annotations (`0023`, `0024`, `0025`)

Wave 6 turns the placeholder `team_id`/`tags` columns from `0022` into a governed model. `teams`
and `team_members` provide the real FK target for record ownership; `tags` is the tenant catalog;
`team_tags` maps which tags a team may use; `record_tags` is a polymorphic finance-record join keyed
by `(record_type, record_id)`. The three finance aggregates keep `tags` JSONB as a denormalized
rule/read cache synced from `record_tags` on write.

```mermaid
erDiagram
  tenants ||--o{ teams : "owns"
  teams ||--o{ team_members : "has"
  users ||--o{ team_members : "member"
  tenants ||--o{ tags : "owns"
  teams ||--o{ team_tags : "allowed tags"
  tags ||--o{ team_tags : "mapped"
  tags ||--o{ record_tags : "attached"

  teams {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name "UK live tenant lower(name)"
    bool is_active
    date deleted_at "paranoid"
  }
  team_members {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid team_id FK
    uuid user_id FK
    string role
  }
  tags {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name "UK live tenant lower(name)"
    string color "nullable"
    bool is_active
    date deleted_at "paranoid"
  }
  team_tags {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid team_id FK
    uuid tag_id FK
  }
  record_tags {
    uuid id PK
    uuid tenant_id FK "RLS"
    string record_type "ApprovalRecordType"
    uuid record_id "polymorphic"
    uuid tag_id FK
    string source "manual|workflow|import"
    uuid added_by "nullable"
  }
```

`record_tags` deliberately does not FK to expense/invoice/payroll rows because `record_type` is
polymorphic. The owning service consumes `RecordUpdated` and is responsible for validating the record
exists under RLS before syncing its aggregate row.

### 3.4 Expense (`0003`, `0016`, `0022`, `0025`)

Header-only expenses (no GL codes, no document-extracted line items). `expenses.report_id` /
`category_id` are nullable with `ON DELETE SET NULL` (an item survives its report/category removal).
`0022` adds `team_id`/`tags`; `0025` wires `team_id` to `teams` and adds `assignee_id`.

```mermaid
erDiagram
  tenants ||--o{ expense_categories : "label set"
  tenants ||--o{ expense_reports : "owns"
  expense_reports ||--o{ expenses : "groups (SET NULL)"
  expense_categories ||--o{ expenses : "classifies (SET NULL)"
  expense_reports ||--o{ expense_approvals : "decided by"
  expense_reports ||--o{ expense_comments : "discussed in"
  expense_reports ||--o{ expense_activities : "timeline"

  expense_categories {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name
    string code "UK live (tenant,code)"
    bool is_active
    date deleted_at "paranoid"
  }
  expense_reports {
    uuid id PK
    uuid tenant_id FK "RLS"
    bigint report_number "UK live (tenant,number)"
    string name
    string status "CHK ExpenseReportStatus, default open"
    uuid submitter_id
    bigint total_amount "money, CHK >=0"
    char currency "default USD"
    int lock_version "optimistic"
    uuid team_id "0022 nullable, FK 0025"
    uuid assignee_id "0025 nullable"
    jsonb tags "0022 nullable"
    date deleted_at "paranoid"
  }
  expenses {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid report_id FK "nullable, SET NULL"
    uuid category_id FK "nullable, SET NULL"
    bigint amount "money, CHK >=0"
    char currency "default USD"
    string merchant
    date incurred_on
    string receipt_ref "pointer only"
    uuid created_by "NOT NULL"
  }
  expense_approvals {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid report_id FK
    uuid approver_id
    string decision "CHK approved|rejected"
    int level "CHK >=0, default 1"
    date decided_at
  }
  expense_comments {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid report_id FK
    uuid user_id
    string body
  }
  expense_activities {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid report_id FK
    uuid user_id
    string activity_type "CHK ExpenseActivityType (widened 0016: +report_recalled)"
    jsonb details
  }
```

### 3.5 Invoice (`0002`, `0017`, `0021`, `0022`, `0025`)

Header-level invoices with a status state machine, a 1:1 `invoice_metadata`, duplicate links, and a
per-level approval/activity trail. `0017`/`0021` add the concurrency-safe dedup index. `0022` adds
`team_id`/`tags`; `0025` wires `team_id` to `teams` and adds `assignee_id`.

```mermaid
erDiagram
  tenants ||--o{ invoices : "owns"
  invoices ||--|| invoice_metadata : "1:1 (invoice_id UK)"
  invoices ||--o{ invoice_duplicates : "flagged as dup of"
  invoices ||--o{ invoice_approvals : "voted on"
  invoices ||--o{ invoice_activities : "timeline"

  invoices {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid vendor_id "nullable cross-service ref"
    string vendor_name
    string invoice_number
    date invoice_date
    date due_date
    bigint amount_minor "money, CHK >=0"
    char currency
    string transaction_type "CHK InvoiceTransactionType, default debit"
    string status "CHK InvoiceStatus, default received"
    bool auto_approved
    uuid approval_policy_id "nullable"
    int lock_version "optimistic"
    uuid team_id "0022 nullable, FK 0025"
    uuid assignee_id "0025 nullable"
    jsonb tags "0022 nullable"
    date deleted_at "paranoid"
    string dedup "UK live non-dup (tenant,vendor_name,number,amount_minor,currency) 0021"
  }
  invoice_metadata {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid invoice_id FK "UK 1:1"
    string invoice_number
    date invoice_date
    bigint amount_minor "money, CHK >=0"
    char currency
  }
  invoice_duplicates {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid invoice_id FK
    uuid duplicate_of FK "-> invoices.id"
    string signature
    string status "CHK InvoiceDuplicateStatus, default flagged"
    uuid resolved_by
    string uq "UK (tenant,invoice_id,duplicate_of)"
  }
  invoice_approvals {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid invoice_id FK
    uuid approver_id
    int approval_level "CHK >=1, default 1"
    string decision "CHK ApprovalDecision"
    bool active "default true"
  }
  invoice_activities {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid invoice_id FK
    uuid user_id
    string activity_type "CHK InvoiceActivityType"
    jsonb details
    string correlation_id
    date created_at "append-only"
  }
```

**Dedup evolution:** `invoices_dup_signature_idx` (non-unique, `0002`) supports lookup but a flagged
duplicate is itself a real row sharing the signature. `0017` adds the partial-unique
`invoices_dup_signature_live_uq` over `(tenant_id, vendor_name, invoice_number, amount_minor)`
`WHERE status <> 'duplicate' AND deleted_at IS NULL` — DB-enforced "at most one live non-duplicate per
signature" so the loser of a concurrent insert gets a `23505` the service maps to `Duplicate`. `0021`
(BUG-0010) **replaces** it with `invoices_dup_signature_cur_live_uq` that adds `currency` to the
signature (two invoices differing only by currency are not duplicates).

### 3.6 Payroll (`0005`, `0018`, `0022`, `0025`)

The largest domain: employees, effective-dated contracts/pay-items/tax-rules, pay calendars, code
catalogs, pay runs → payslips → payslip lines, payments (batched, idempotent), and the append-only
double-entry ledger. `tax_rules.tenant_id` is **nullable** (NULL = platform default). `0022` adds
`team_id`/`tags` to `pay_runs`; `0025` wires `team_id` to `teams` and adds `assignee_id`.

```mermaid
erDiagram
  tenants ||--o{ employees : "employs"
  employees ||--o{ employment_contracts : "effective-dated"
  employees ||--o{ employee_pay_items : "recurring items"
  employees ||--o{ payroll_input_items : "ad-hoc inputs"
  employees ||--o{ payslips : "paid via"
  tenants ||--o{ pay_calendars : "schedules"
  tenants ||--o{ earning_codes : "catalog"
  tenants ||--o{ deduction_codes : "catalog"
  tenants ||--o{ tax_rules : "rules (NULL tenant=default)"
  pay_calendars ||--o{ pay_runs : "drives (SET NULL)"
  pay_runs ||--o{ payslips : "produces"
  payslips ||--o{ payslip_lines : "breaks down"
  pay_runs ||--o{ payment_batches : "disburses"
  payslips ||--o{ payments : "settles"
  payment_batches ||--o{ payments : "groups (SET NULL)"
  pay_runs ||--o{ ledger_entries : "posts (append-only)"

  employees {
    uuid id PK
    uuid tenant_id FK "RLS"
    string employment_status "CHK EmploymentStatus, default active"
    string work_jurisdiction
    text bank_account_enc "encrypted"
    text national_id_enc "encrypted"
    text tax_identifier_enc "encrypted"
    int lock_version "optimistic"
    date deleted_at "paranoid"
  }
  employment_contracts {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid employee_id FK
    date effective_from
    date effective_to "nullable"
    string type "CHK ContractType, default salaried"
    text base_amount_enc "encrypted"
    decimal fte "CHK null or >=0"
    string pay_frequency "CHK PayFrequency, default monthly"
  }
  pay_calendars {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name "UK live (tenant,name)"
    string frequency "CHK PayFrequency, default monthly"
    date deleted_at "paranoid"
  }
  earning_codes {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name "UK live (tenant,name)"
    bool taxable "default true"
    date deleted_at "paranoid"
  }
  deduction_codes {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name "UK live (tenant,name)"
    bool pre_tax "default false (0018: is_pre_tax fallback)"
    bool employer_contribution
    date deleted_at "paranoid"
  }
  tax_rules {
    uuid id PK
    uuid tenant_id FK "NULLABLE = platform default"
    string jurisdiction
    string rule_type "CHK TaxRuleType"
    date effective_from
    date effective_to
    jsonb params
    int version "CHK >=1 (domain version, not lock)"
    date deleted_at "paranoid"
  }
  employee_pay_items {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid employee_id FK
    uuid code_id "nullable"
    string code_kind "CHK PayItemKind"
    bigint amount_or_rate "money, CHK >=0"
    string frequency "CHK PayFrequency, default monthly"
    date effective_from
  }
  pay_runs {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid pay_calendar_id FK "nullable, SET NULL"
    date period_start
    date period_end
    date pay_date
    string type "CHK PayRunType, default regular"
    string status "CHK PayRunStatus, default draft"
    uuid created_by "NOT NULL"
    jsonb locked_snapshot
    int lock_version "optimistic"
    uuid team_id "0022 nullable, FK 0025"
    uuid assignee_id "0025 nullable"
    jsonb tags "0022 nullable"
    date deleted_at "paranoid; UK live (tenant,cal,start,end,type)"
  }
  payslips {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid pay_run_id FK
    uuid employee_id FK
    bigint gross "money, CHK >=0"
    bigint taxable_base "money, CHK >=0"
    bigint total_tax "money, CHK >=0"
    bigint total_deductions "money, CHK >=0"
    text net_enc "encrypted"
    string status "CHK PayslipStatus, default draft"
    string uq "UK (pay_run_id,employee_id)"
  }
  payslip_lines {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid payslip_id FK
    string kind "CHK PayItemKind"
    uuid code_id "nullable"
    string source "CHK PayslipLineSource, default base"
    bigint amount "money, CHK >=0"
    bool taxable
  }
  payroll_input_items {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid employee_id FK
    string source
    string idempotency_key "UK exactly-once"
    bigint amount "money, CHK >=0"
    string settlement "CHK SettlementMode, default cyclic"
    string status "CHK PayrollInputStatus, default pending"
  }
  payment_batches {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid pay_run_id FK
    string file_ref
    string status "CHK PaymentStatus, default pending"
  }
  payments {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid payslip_id FK
    uuid batch_id FK "nullable, SET NULL"
    bigint amount "money, CHK >=0"
    string status "CHK PaymentStatus, default pending"
    string idempotency_key "UK exactly-once"
    string rail_ref
  }
  ledger_entries {
    uuid id PK
    uuid tenant_id FK "RLS + no-UPDATE/no-DELETE policies"
    uuid pay_run_id FK
    string account "CHK LedgerAccount"
    bigint debit "money, CHK >=0"
    bigint credit "money, CHK >=0"
    uuid reversal_of "self-ref correction"
    date posted_at
  }
```

`0018` (W5-05) is purely additive: it adds `is_pre_tax` to `deduction_codes` **only if neither
`pre_tax` nor `is_pre_tax` already exists** (the `0005` schema already ships `pre_tax`, which stays
canonical), and adds the covering index `tax_rules_jurisdiction_type_effective_idx` on
`(jurisdiction, rule_type, effective_from)` for the effective-dated tax resolver.

### 3.6 Workflow (`0004`)

A rules-as-data engine: a `rules` aggregate root with ordered `rule_steps` (JSONB queries) and
`rule_actions` (typed config), plus an append-only `rule_audit_logs` verdict log.

```mermaid
erDiagram
  tenants ||--o{ rules : "owns"
  rules ||--o{ rule_steps : "evaluates"
  rules ||--o{ rule_actions : "executes"
  rules ||--o{ rule_audit_logs : "logs runs"

  rules {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name "UK live (tenant,name)"
    string event "CHK RuleEvent"
    bool active "default true"
    date last_run
    int lock_version "optimistic"
    date deleted_at "paranoid"
  }
  rule_steps {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid rule_id FK
    int order "CHK >=0"
    jsonb query
  }
  rule_actions {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid rule_id FK
    string type "CHK RuleActionType"
    jsonb config
  }
  rule_audit_logs {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid rule_id FK
    string status "CHK RuleRunStatus"
    jsonb detail
    date created_at "append-only"
  }
```

### 3.7 Notification & Email plane (`0006`, `0014`, `0019`)

In-app notifications (dedup-keyed), the status-tracked email send log (exactly-once), per-user/tenant
channel preferences, per-tenant sender identity + master-switch, and the suppression list.
`email_sender_identities` is a **notification-service-local** table — it is not in the shared
`TableName` enum (its name is a string literal), but it is still RLS-keyed.

```mermaid
erDiagram
  tenants ||--o{ notifications : "in-app inbox"
  users ||--o{ notifications : "recipient"
  tenants ||--o{ email_notification_logs : "send log"
  users ||--o{ email_notification_logs : "recipient (SET NULL)"
  tenants ||--o{ notification_preferences : "channel opt-out"
  users ||--o{ notification_preferences : "per-user (CASCADE)"
  tenants ||--|| email_sender_identities : "1 identity/tenant"
  tenants ||--o{ email_suppressions : "suppression list"

  notifications {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid user_id FK
    string code "CHK NotificationCode"
    jsonb message
    string correlation_id
    date read_at
    string uq "UK (tenant,user,code,correlation_id) dedupe"
  }
  email_notification_logs {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid user_id FK "nullable, SET NULL"
    string email
    string template_name
    jsonb payload
    string status "CHK EmailNotificationStatus (widened 0019)"
    string idempotency_key "UK (tenant,idempotency_key)"
    date sent_at
  }
  notification_preferences {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid user_id FK "NULL = tenant default"
    string event_type
    string channel "CHK NotificationChannel"
    bool enabled "default true; absence = on"
    string uq "UK partial: per-user + tenant-default"
  }
  email_sender_identities {
    uuid id PK
    uuid tenant_id FK "RLS; UK (tenant) 1 row"
    string from_name
    string from_email
    string reply_to
    bool email_enabled "master switch, default true"
  }
  email_suppressions {
    uuid id PK
    uuid tenant_id FK "RLS"
    string address "normalized lower-case"
    string reason "CHK EmailSuppressionReason"
    string source
    date created_at "append-only; UK (tenant,address)"
  }
```

`0019` widens `email_notification_logs_status_chk` from `pending|sent|failed` to the full
`EmailNotificationStatus` set (adds policy not-sent states `suppressed|disabled|blocked`).
`notification_preferences` uses **two partial-unique indexes** — one for non-NULL `user_id`, one for
the NULL-user tenant default — because NULLs are distinct in a plain unique index.

### 3.8 Reporting (CQRS-lite read side) (`0007`)

Declarative definitions (compiled, never raw SQL), schedules, async runs, and per-role
column/row access policies. `report_definitions` is paranoid; `report_runs` is append-once.

```mermaid
erDiagram
  tenants ||--o{ report_definitions : "owns"
  report_definitions ||--o{ report_schedules : "scheduled by"
  report_definitions ||--o{ report_runs : "executed as"
  tenants ||--o{ report_access_policies : "governs"

  report_definitions {
    uuid id PK
    uuid tenant_id FK "RLS"
    string name
    jsonb spec "measures/dimensions/filters/grain/source"
    string required_permission
    uuid created_by "NOT NULL"
    date deleted_at "paranoid"
  }
  report_schedules {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid definition_id FK
    string cron
    string timezone "default UTC"
    bool enabled "default true"
  }
  report_runs {
    uuid id PK
    uuid tenant_id FK "RLS"
    uuid definition_id FK
    uuid requested_by "NOT NULL"
    jsonb params
    string status "CHK ReportRunStatus, default queued"
    date started_at
    date finished_at "CHK finished>=started"
    text artifact_url
    text error
  }
  report_access_policies {
    uuid id PK
    uuid tenant_id FK "RLS"
    string role "UK (tenant,role)"
    jsonb allowed_columns
    jsonb masked_columns
    text row_filter "row-level scope predicate"
  }
```

### 3.9 Connectors (`0020`)

Durable ERP push idempotency. One row per `(tenant_id, idempotency_key)` (UNIQUE) makes a push
outcome survive worker restarts / Kafka rebalances; a reconcile poll advances non-terminal rows.

```mermaid
erDiagram
  tenants ||--o{ connector_sync_state : "push outcomes"

  connector_sync_state {
    uuid id PK
    uuid tenant_id "RLS (plain uuid, not FK)"
    string kind "ConnectorKind"
    string entity "ConnectorEntity"
    string record_id "business id, NOT unique"
    string idempotency_key "UK (tenant,idempotency_key)"
    string status "synced|queued|in_progress|error, default in_progress"
    string external_id "ERP-assigned id"
    int attempts
    text last_error
  }
```

### 3.10 Platform (audit / activity / outbox / config / casbin) (`0008`–`0011`, `0015`)

Cross-cutting infrastructure. `audit_log` (hash-chained security log), `activity_log` (polymorphic
business timeline), `event_outbox` (transactional outbox + relay bypass), `tenant_config` /
`tenant_features` (per-tenant settings & flags), `casbin` (global policy store, **no RLS**).

```mermaid
erDiagram
  tenants ||--o{ tenant_config : "settings"
  tenants ||--o{ tenant_features : "flags"

  audit_log {
    uuid id PK
    uuid tenant_id "RLS (plain uuid)"
    uuid actor_id "nullable"
    string action
    string outcome
    string resource_type
    uuid resource_id
    jsonb details
    jsonb permissions
    string prev_hash "hash chain"
    string hash "hash chain"
    date created_at "append-only"
  }
  activity_log {
    uuid id PK
    uuid tenant_id "RLS (plain uuid)"
    string record_type "polymorphic"
    uuid record_id
    uuid actor_id "nullable"
    string action
    jsonb details
    string correlation_id
    date created_at "append-only"
  }
  event_outbox {
    uuid id PK
    uuid tenant_id "RLS + relay-bypass OR app.outbox_relay"
    string topic
    jsonb payload
    jsonb envelope "full EventEnvelope"
    string status "default pending"
    int attempts
    text last_error
    date published_at
    date created_at "append-only; partial idx WHERE pending"
  }
  tenant_config {
    uuid id PK
    uuid tenant_id FK "RLS"
    string key
    jsonb value
    string uq "UK (tenant,key)"
  }
  tenant_features {
    uuid id PK
    uuid tenant_id FK "RLS"
    string flag
    bool enabled "default false"
    string uq "UK (tenant,flag)"
  }
  casbin {
    int id PK "serial (NOT uuid)"
    text ptype "p | g"
    jsonb rule "UK; [sub,dom,act,eft] or [user,role,dom]; dom=tenantId"
  }
```

**Outbox flow (transactional outbox pattern):**

```mermaid
flowchart LR
  subgraph tx["Business transaction (app.current_tenant set)"]
    W["Domain write<br/>(e.g. invoice approved)"] --> O["INSERT event_outbox<br/>status=pending"]
  end
  tx -->|COMMIT atomic| DB[(event_outbox)]
  RELAY["Relay / PROCESS_TYPE=relay<br/>SET LOCAL app.outbox_relay='on'"] -->|poll WHERE status=pending| DB
  RELAY -->|at-least-once publish| BUS["Kafka topic"]
  RELAY -->|mark published_at| DB
```

The outbox row is written **inside the same tenant transaction** as the business write, so the event
is persisted atomically — no dual-write window. The relay's `app.outbox_relay='on'` lets one poll
drain every tenant's pending rows (the RLS OR-clause), while producers stay strictly isolated.

`casbin` policy semantics (model in `libs/access-control/src/enforcer.ts`):

- **p-rule:** `rule = [sub, dom, act, eft]` — `sub` = role | userId, `dom` = tenantId | `'*'`, `act` = permission.
- **g-rule:** `rule = [user, role, dom]` — user has role in tenant domain `dom`.

Tenant scoping is expressed _inside_ each rule via `dom` (`dom = tenantId`), which is why the table
needs neither a `tenant_id` column nor RLS.

---

## 4. Cross-domain relationships (the seams)

Several references cross service boundaries and are **intentionally not DB foreign keys** (the domains
own separate aggregates; integrity is upheld by events + the service layer):

```mermaid
flowchart TB
  subgraph identity
    U[users]
    R[roles]
  end
  subgraph approvals
    RA["record_approvers / approvals<br/>(record_type, record_id)"]
  end
  subgraph finance
    EXP[expense_reports]
    INV[invoices]
    PR[pay_runs]
  end
  subgraph annotations
    TM[teams]
    TG[tags]
    RT[record_tags]
  end
  RA -. "polymorphic (no FK)" .-> EXP
  RA -. "polymorphic (no FK)" .-> INV
  RA -. "polymorphic (no FK)" .-> PR
  EXP -. "team_id FK" .-> TM
  INV -. "team_id FK" .-> TM
  PR -. "team_id FK" .-> TM
  EXP -. "assignee_id FK" .-> U
  INV -. "assignee_id FK" .-> U
  PR -. "assignee_id FK" .-> U
  RT -. "polymorphic record_type/id" .-> EXP
  RT -. "polymorphic record_type/id" .-> INV
  RT -. "polymorphic record_type/id" .-> PR
  RT --> TG
  INV -. "vendor_id (nullable, no FK)" .-> VEND["vendor (external)"]
  AL["activity_log / audit_log<br/>(record_type, record_id / resource_id)"] -. "polymorphic (no FK)" .-> EXP
  AL -. polymorphic .-> INV
  AL -. polymorphic .-> PR
  CSS["connector_sync_state<br/>(record_id, idempotency_key)"] -. "by business id (no FK)" .-> INV
  CSS -. by business id .-> PR
  WF["rule_actions assign_team/add_tag/remove_tag/assign_owner<br/>via RecordUpdated event"] -. "team_id / assignee_id / tags cache" .-> EXP
  WF -. event-driven .-> INV
  WF -. event-driven .-> PR
```

- **Approvals** link to expense/invoice/pay-run purely by `(record_type, record_id)` — no FK.
- **`invoices.vendor_id`** is a nullable cross-service reference with no FK.
- **`audit_log` / `activity_log` / `event_outbox` / `connector_sync_state`** carry `tenant_id` as a
  **plain UUID** (RLS-keyed) — they are deliberately _not_ FK-bound to `tenants` so the logs/outbox
  survive independently and can be written in contexts where the FK would be inconvenient.
- **Workflow `assign_team` / `add_tag` / `remove_tag` / `assign_owner`** write through the
  `RecordUpdated` event. The finance services persist `team_id`, `assignee_id`, and `record_tags`, then
  refresh the denormalized `tags` JSONB cache for rule facts and fast reads.

---

## 5. Enum-backed CHECK constraints

Every status/type/kind column is pinned by a `CHECK (col IN (...))` whose value list is rendered from
the corresponding `@aegis/shared-enums` enum at migration time (the enum is the single source of
truth shared by the CHECK, the DTO type, and the write sites). Because a CHECK snapshots the value set
at author time, _adding_ an enum value requires a drop-and-re-add migration — exactly what `0016`
(expense `report_recalled`) and `0019` (email policy not-sent states) do. Numeric invariants are
likewise pinned: money columns `>= 0`, `min_approvals >= 1`, `level >= 1`, `depth >= 0`,
`tax_rules.version >= 1`, ledger `debit/credit >= 0`, and `report_runs.finished_at >= started_at`.
