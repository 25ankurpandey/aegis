# Labels / Tags / Filtering — Gap Analysis + Wave-6 Backlog

**Area:** labels / tags / record filtering / rule conditions on team·tag·assignee
**Auditor stance:** skeptical, evidence-first. The domain donor is a READ-ONLY reference.
**Donor (domain):** local domain reference repo — production AP/invoice/job platform.
**Ours:** `/Users/ankurpandey/Documents/GitHub/aegis` — expense / invoice / payroll + shared approvals + workflow rules engine.

> **This document SUPERSEDES the minimal BUG-0011 / BUG-0003 team-tags patch.** That patch
> (`apps/cli/src/migrations/0022_record_team_tags.ts`) bolted a nullable `team_id` UUID + a `tags`
> JSONB column onto `expense_reports`, `invoices`, `pay_runs` so the workflow `assign_team` / `add_tag`
> actions had somewhere to land. It is a write-only sink: **no catalog, no validation, no list
> filtering, no rule conditions, and `team_id` references a `teams` table that does not exist.** The
> Wave-6 design below is the complete, filterable, rule-usable version that patch was a placeholder for.

---

## TL;DR verdict (updated 2026-06-27)

The Wave-6 gap is now implemented behind the `record.annotations` tenant feature flag. The repo has
the missing team/team-member tables, a tenant tag catalog, team→tag mapping, polymorphic `record_tags`,
`assignee_id` on the three finance aggregates, list filters for tag/team/assignee/status, workflow set
conditions, an `assign_owner` action, and RBAC-protected governance routes in user-management.

The original audit remains below because it explains the donor-derived shape and the sequencing. Before
Wave 6, Aegis could only write bare `team_id`/`tags` columns; after Wave 6, `record_tags` is the source
of truth and the legacy JSONB `tags` column is a denormalized rule/read cache synced on write.

| #   | Capability                                | Domain donor                                                                      | Aegis (ours)                                                                       | Gap                                 |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | Tenant catalog of legal tags              | `tags` table, `(name, company_id)` unique, `active` flag, CITEXT name             | `tags` table (`tenant_id`, name/color/active, audit, soft-delete)                  | **IMPLEMENTED**                     |
| 2   | Record ↔ tag link                         | `job_tags` join (job + optional line item), unique, `source`, `added_by`          | `record_tags` polymorphic join + denormalized JSONB cache                          | **IMPLEMENTED**                     |
| 3   | Label vs tag distinction                  | tags double as labels (filter UI calls them "labels")                             | none                                                                               | n/a — one concept suffices for us   |
| 4   | Team → tag mapping                        | `team_tags` join                                                                  | `team_tags` with `tenant_id, team_id, tag_id` uniqueness                           | **IMPLEMENTED**                     |
| 5   | Team on a record                          | `jobs.team_id` FK → `teams`                                                       | `teams`/`team_members` tables + `team_id` FK on finance aggregates                 | **IMPLEMENTED**                     |
| 6   | Assignee / owner on a record              | `job_assignees` (owner_id, auditor_id) + `jobs.membership_id` creator             | `assignee_id` column on finance aggregates                                         | **IMPLEMENTED**                     |
| 7   | List filter by tag                        | `filterByJobTagsV3` — `any`/`all`/`none` + `NONE` sentinel, ops-vs-tenant scoping | shared `withRecordAnnotationListFilters` + query parser                            | **IMPLEMENTED**                     |
| 8   | List filter by team                       | `filterByJobTeamV2` — `any`/`none` + `NONE`                                       | shared team filter with `NONE` support                                             | **IMPLEMENTED**                     |
| 9   | List filter by owner/assignee             | `job-owner-v4` — creator∪assignee, `any`/`none` + no-owner                        | shared assignee filter with `me`/`NONE` support                                    | **IMPLEMENTED**                     |
| 10  | Rules **trigger** on tag change           | `callTagBasedTriggerEngineAPI` (add/update/remove)                                | manual tag changes stage `RecordUpdated`; workflow reacts to `RecordUpdated` facts | **IMPLEMENTED**                     |
| 11  | Rules **act** on tags                     | `jobTaggingAction` / `job-remove-tagging` (engine-applied, `source=WORKFLOW`)     | `add_tag` / `assign_team` actions exist                                            | **PRESENT** (the one piece we have) |
| 12  | Rules **condition** on tags/team/assignee | filter framework reused in rule audit                                             | `tags` set validator, `team_id`, `assignee_id` scalar validators                   | **IMPLEMENTED**                     |
| 13  | Tag permissions (RBAC)                    | `tag.create/edit/delete/assign/list`, `jobs.edit.tags.add/delete`                 | `tag.*`, `record.tag.*`, `record.assign`, `team.tag.manage`                        | **IMPLEMENTED**                     |

---

## 1. What the donor actually does (backend evidence)

### 1.1 Data model

**`tags` — the tenant catalog** (`libs/document/migrations/src/migrations/0102_tags.ts`):

```
id UUID PK, name (CITEXT, see 0344) NOT NULL, company_id UUID NULL → companies.id,
active BOOLEAN NOT NULL default true, created_at, updated_at
UNIQUE (name, company_id)
```

- `company_id` NULL = a global / "ops" tag (the donor's platform-operator tags); non-null = tenant-owned.
- `0344_change_tag_name_type.ts` makes `name` **CITEXT** → case-insensitive uniqueness ("Travel" == "travel").
- `0358_remove_name_company_constraint_tags.ts` later relaxes the constraint (history; the net is name+company uniqueness with the ops-tag carve-out).

**`job_tags` — the record↔tag join** (`0104_job_tags.ts`, extended by `0323`, `0488`, `0539`):

```
id serial PK, tag_id UUID → tags.id, job_id UUID → jobs.id,
job_line_item_id UUID NULL (0323 — tag a single line item, not just the header),
added_by UUID → users.id (0488 — provenance),
source VARCHAR(100) NULL (0539 — 'WORKFLOW' | manual | import),
UNIQUE (job_id, tag_id, job_line_item_id) + partial unique where line_item IS NULL
```

This is the load-bearing pattern: **a real join table with a catalog FK + provenance**, NOT a JSONB blob.

**`team_tags` — team→tag mapping** (`0128_team_tags.ts`):

```
id serial PK, team_id UUID → teams.id ON DELETE CASCADE,
tag_id UUID → tags.id ON DELETE CASCADE, UNIQUE (team_id, tag_id)
```

Lets an admin scope which tags a team may use / is associated with.

**Team & assignee ON the record:**

- `jobs.team_id` UUID → `teams.id` (`0316_add_team_id_column_in_jobs_table.ts`).
- `job_assignees` (`0112_job_assignees_table.ts`): `job_id`, `owner_id → users`, `auditor_id → users`, UNIQUE(owner_id, auditor_id, job_id). Plus the creator is derived via `jobs.membership_id`.

**Fuzzy line-item↔tag suggestions** (`0366_job_line_item_tag_fuzzy_matches.ts`) — `match_type` + `scores` JSONB. **OUT OF SCOPE for us** (an ML enrichment feature, frontend-driven; flag and skip).

### 1.2 List filtering (the read surface we completely lack)

The donor has a **generic QueryBuilder filter framework** — one file per filterable field under
`libs/services/backend/src/job/list-v2/filters/` (`job-tags-v3.ts`, `job-teams-v2.ts`, `job-owner-v4.ts`,
`job-reviewers-v2.ts`, `job-status.ts`, `job-amounts.ts`, …). Each takes a `{ field, operator, value }`
predicate and returns a SQL fragment + bound params.

- **Operators** (`QueryBuilderOperator`): `any`, `all`, `none` (set membership), plus `between`,
  `greater`, `less`, `equals`, `in`, `contains`, `empty`, … (`libs/.../enums` QueryBuilderOperator).
- **Tag filter** (`filterByJobTagsV3`): EXISTS-subquery against `job_tags ⋈ tags`, three set semantics:
  - `any` → record has ≥1 of the selected tags;
  - `all` → `HAVING count(distinct tag_id) = N` (has every selected tag);
  - `none` → `NOT EXISTS`.
  - A `'NONE'` sentinel value = "records with no tag at all" (unioned in). Ops-vs-tenant scoping via
    `tags.company_id IS NULL` vs `= :companyId`.
- **Team filter** (`filterByJobTeamV2`): `any`/`none` over `jobs.team_id`, with `'NONE'` = unteamed.
- **Owner filter** (`job-owner-v4`): unions creator (`jobs.membership_id → memberships.user_id`) with
  assignees (`job_assignees.owner_id`), `any`/`none` + a "no owner" branch.

The list controller (`apps/backend/src/app/controllers/job/list-job-router.ts`) validates `tagId`
(comma list, UUIDs or `NONE`), and `list/list.ts` runs the assembled predicate set with pager + sort.

### 1.3 Rules engine on tags/teams

- **Trigger:** `proxy-engine-api/tag-based-trigger.ts` — `callTagBasedTriggerEngineAPI({ tag_action:
'add'|'update'|'remove', tag_ids, job_ids })` fires the rules engine when a tag changes.
- **Action:** `rule/actions/job-tagging.ts` (`jobTaggingAction`) attaches catalog tags to a job under a
  system account, idempotently (locks the job row, skips already-linked tags), writing
  `source = WORKFLOW`; `job-remove-tagging.ts` is the inverse. (This is the ONE capability Aegis already
  has, via `RuleActionType.AddTag` / `AssignTeam`.)

### 1.4 RBAC

`0109_assign_tags_permission.ts` + `0142_ops_tag_permissions.ts` seed `tag.create`, `tag.edit`,
`tag.delete`, `tag.assign`, `tag.list`, and record-scoped `jobs.edit.tags.add` / `jobs.edit.tags.delete`,
mapped to roles. Admin/Editor/Contributor can mutate; everyone can list.

---

## 2. What we have now (Aegis evidence)

- **Schema foundation:** `0023_teams.ts` creates `teams` / `team_members`; `0024_tags.ts` creates the
  tenant `tags` catalog + `team_tags`; `0025_record_annotations.ts` creates the polymorphic
  `record_tags` join, adds `assignee_id` to `expense_reports` / `invoices` / `pay_runs`, and wires the
  previously dangling `team_id` FK to `teams`.
- **Feature gate:** governance endpoints, annotation list filters, and async record-update writes are
  behind `record.annotations` (`RecordAnnotationFeatureFlag`) using `FeatureFlags.isEnabled(...)`. No
  tenant gets the new annotation surface until the flag is enabled.
- **Governance API:** `AnnotationGovernanceController` in user-management exposes team CRUD,
  team-member writes, tag CRUD, team-tag mapping, record-tag attach/remove, and record assignment.
  Routes are guarded by `team.manage`, `tag.*`, `team.tag.manage`, `record.tag.*`, and `record.assign`.
- **Write path:** workflow `assign_team`, `add_tag`, `remove_tag`, and `assign_owner` publish
  `RecordUpdated`; the expense/invoice/payroll consumers persist `team_id`, `assignee_id`, and
  `record_tags`, then refresh the JSONB `tags` cache from the join.
- **Read path:** the three finance list endpoints call `parseRecordAnnotationQuery(...)` and compile
  tag/team/assignee/status predicates through `withRecordAnnotationListFilters(...)`. Supported
  semantics are `tagMatch=any|all|none`, `tag=NONE`, `team=NONE`, `assignee=NONE`, and `assignee=me`.
- **Rules path:** `RuleOperator.HasAny` / `HasAll` / `HasNone` evaluate array-valued `tags`; `team_id`
  and `assignee_id` are scalar facts. `RuleActionType.AssignOwner` assigns a record via the same
  outbox path as team/tag annotations.
- **RBAC seed:** `0001_system_roles.ts` seeds the new dotted permissions into the catalog and grants
  manager/admin-style roles mutation rights while retaining read/list access for lower-privilege roles
  where appropriate.

---

## 3. Wave-6 backlog (scoped to our use case)

Design principle: mirror the donor's **catalog + join** for governance and filtering, but keep our
clean single-tag concept (we do not need the donor's line-item tagging, fuzzy ML matching, or the
label-vs-tag UI split). Keep the existing `tags` JSONB as a **denormalized read cache** synced from the
join (optional, see B3) so the already-shipped write path keeps working during migration.

### 3.0 Naming decision (do this first)

We adopt **one concept: "tags"** (a tenant catalog of classification labels). "Label" and "tag" are the
same thing for finance records — we won't carry two tables. Where the spec says "labels", read "tags".

### B1 — Tenant tag catalog + polymorphic record↔tag join (the core)

**New tables** (add to `libs/shared/enums/src/table-name.enum.ts`):

```
Tags             = 'tags'
RecordTags       = 'record_tags'
TeamTags         = 'team_tags'
```

`tags` (per-tenant catalog, RLS-scoped, mirrors `expense_categories` which we already have):

```
id UUID PK, tenant_id UUID NOT NULL,
name CITEXT NOT NULL,                 -- case-insensitive
color VARCHAR(16) NULL,               -- optional UI hint
is_active BOOLEAN NOT NULL default true,
created_by, updated_by UUID NULL, created_at, updated_at, deleted_at (paranoid),
PARTIAL UNIQUE (tenant_id, name) WHERE deleted_at IS NULL   -- per B6-schema finding (a)
```

`record_tags` (polymorphic join — one table for all three record types, keyed by `record_type`):

```
id UUID PK, tenant_id UUID NOT NULL,
record_type VARCHAR NOT NULL,         -- reuse ApprovalRecordType (expense_report|invoice|pay_run)
record_id UUID NOT NULL,
tag_id UUID NOT NULL → tags.id,
source VARCHAR(32) NULL,              -- 'manual' | 'workflow' | 'import'  (donor's `source`)
added_by UUID NULL,                   -- provenance (donor's `added_by`)
created_at,
UNIQUE (tenant_id, record_type, record_id, tag_id),
INDEX (tenant_id, tag_id),            -- "list records with tag X"
INDEX (tenant_id, record_type, record_id)  -- "tags on this record"
```

Polymorphic join chosen over per-service join tables because it (a) reuses `ApprovalRecordType` which
already spans the three services, (b) keeps one filter/condition implementation, (c) matches the donor's
single `job_tags` table. RLS-scoped on `tenant_id`; cross-record-type isolation by `record_type`.

`team_tags` (team→tag mapping, donor `0128`): `tenant_id, team_id → teams.id, tag_id → tags.id,
UNIQUE(tenant_id, team_id, tag_id)`. Governs which tags a team may apply (optional enforcement at
attach time).

| field  | value                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| why    | Without a catalog, tags are unvalidated free-strings; you cannot rename, deactivate, color, or govern them, and you cannot reliably filter (typos fork the value space). The join gives provenance + the `any/all/none` filter joins.            |
| tables | new `tags`, `record_tags`, `team_tags`                                                                                                                                                                                                           |
| files  | new migration `0023_tags_catalog.ts`; `libs/shared/enums/src/table-name.enum.ts`; new models `apps/{expense,invoice,payroll}/src/models/*` OR a shared `@aegis/...` tag model; tag CRUD controller/service/repo (user-management or per-service) |
| effort | M (catalog + join + models); migration is additive                                                                                                                                                                                               |

### B2 — Create the missing `teams` / `team_members` tables + record FK

`TableName.Teams` / `TableName.TeamMembers` are enum-declared but never migrated, so `team_id` and the
`assign_team` action currently write a dangling UUID.

```
teams:        id UUID PK, tenant_id UUID NOT NULL, name CITEXT NOT NULL, is_active BOOLEAN,
              created_by/updated_by, paranoid; PARTIAL UNIQUE (tenant_id, name) WHERE deleted_at IS NULL
team_members: id UUID PK, tenant_id, team_id → teams.id, user_id → users.id, role VARCHAR NULL,
              UNIQUE (tenant_id, team_id, user_id)
```

Then add the FK from `expense_reports.team_id` / `invoices.team_id` / `pay_runs.team_id` → `teams.id`
(was added as a bare UUID by 0022).

| field  | value                                                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| why    | `team_id` is meaningless without a `teams` table; team filtering (B4) and team-scoped row access need real team membership. Closes the dangling-FK defect 0022 introduced. |
| tables | new `teams`, `team_members`; ALTER `expense_reports`/`invoices`/`pay_runs` add FK                                                                                          |
| files  | migration `0024_teams.ts`; `team` models + CRUD in user-management (`apps/user-management/src/*`)                                                                          |
| effort | M                                                                                                                                                                          |

### B3 — Assignee / owner on records

Add a record **assignee** so workflows can route ownership and lists can filter "assigned to me". Two
options; recommend the simpler **column** unless multi-assignee is needed:

- **Option A (recommended):** `assignee_id UUID NULL → users.id` column on each of the three aggregates
  (+ index `(tenant_id, assignee_id)`). Keep the existing `submitter_id`/`created_by` as the creator.
- **Option B (donor parity):** a `record_assignees` polymorphic join (owner_id, optional auditor_id)
  mirroring `job_assignees` — only if a record can have multiple owners.

Add a workflow action `RuleActionType.AssignOwner` (mirrors `AssignTeam`) emitting `RecordUpdated` with
`assigneeId`; extend each `record-update.consumer.ts` + `applyLabels`/`applyRecordUpdate` to persist it.

| field  | value                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| why    | No way to assign or filter by owner today; "my queue" and owner-based rule conditions are impossible. The donor's owner filter unions creator∪assignee. |
| tables | ALTER `expense_reports`/`invoices`/`pay_runs` add `assignee_id` (Option A) OR new `record_assignees` (Option B)                                         |
| files  | the three models; the three `record-update.consumer.ts` + repos; `builtin.ts` (new action); `workflow.enum.ts` (RuleActionType.AssignOwner)             |
| effort | S (Option A) / M (Option B)                                                                                                                             |

### B4 — Filterable LIST endpoints

Replace the submitter-only `listReports` (and add the equivalents for invoice & pay-run) with a filtered
list:

```
GET /expense/reports?tag=<id|NONE,...>&team=<id|NONE,...>&assignee=<id|me|NONE>&status=<...>
                     &tagMatch=any|all|none&page=&pageSize=
GET /invoice/invoices?tag=&team=&assignee=&status=&tagMatch=...
GET /payroll/pay-runs?tag=&team=&assignee=&status=...
```

Repository: extend `ListReportsOptions` (`libs/shared/types/src/expense.shape.ts:109`) with
`tagIds?: string[]`, `tagMatch?: 'any'|'all'|'none'`, `teamIds?: string[]`, `assigneeId?: string`,
`status?: string`. In the repo, compile:

- **tag** → EXISTS subquery on `record_tags` (Sequelize `literal` or a join), with `any`/`all`
  (`HAVING count(distinct tag_id)=N`)/`none` + the `'NONE'` (untagged) sentinel — port
  `filterByJobTagsV3`'s shape.
- **team** → `where team_id IN (...)` + `NONE` = `team_id IS NULL` (port `job-teams-v2`).
- **assignee** → `where assignee_id = :id` (`me` resolved from RequestContext), `NONE` = null.
- **status** → plain `where status IN (...)`.
- All under the RLS-scoped transaction (tenant isolation already enforced).

| field  | value                                                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| why    | The entire read value of tags/teams/assignee is filtering; today none exists. This is the headline Wave-6 deliverable.                                                                                                                                                                      |
| tables | reads `record_tags`, `tags`, `teams`, the three aggregates                                                                                                                                                                                                                                  |
| files  | `apps/{expense,invoice,payroll}/src/repositories/*.repository.ts` (list method); `...controllers/*.controller.ts` (query parsing — extend the `clampInt` block at `expense-report.controller.ts:193`); validators; `libs/shared/types/src/{expense,invoice,payroll}.shape.ts` (ListOptions) |
| effort | L (three services × filter compiler) — extract a shared filter helper in a lib to avoid 3× duplication                                                                                                                                                                                      |

### B5 — Rules-engine CONDITION operators on tag / team / assignee

Today the engine can _act_ on tags/teams but cannot _branch_ on them. Add:

- **Operators:** extend `RuleOperator` (`libs/shared/enums/src/workflow.enum.ts`) with set operators
  `HasAny = 'has_any'`, `HasAll = 'has_all'`, `HasNone = 'has_none'` (or overload existing
  `In`/`Contains` — but explicit set operators match the donor's `any/all/none` and read clearly).
- **Validators** (`apps/workflow/src/engine/validators/builtin.ts`, `registerBuiltinValidators`):
  - a **`tags`** validator: LHS = `ctx.record['tags']` (array, or fetched from `record_tags`), RHS =
    tag id/name list; implement `has_any`/`has_all`/`has_none`. Note `compareScalar`'s `Contains`
    already does array-LHS membership — extend with the set operators.
  - an **`assignee_id`** scalar validator (one line: `scalarValidator('assignee_id')`).
  - `team_id` scalar validator already exists — keep.
- The facts payload (`ctx.record`) already carries `tags` for `record.updated`; ensure the rule
  evaluation context for `record.created`/`record.submitted` also includes `tags`/`team_id`/`assignee_id`
  (denormalized `tags` JSONB column makes this cheap — another reason to keep it as a read cache, B1).

| field  | value                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| why    | Workflows like "if tag=urgent AND amount>5000 → assign team Finance" or "if assignee is empty → notify manager" are impossible today; this makes tags/teams/assignee first-class rule inputs, closing the loop with the existing actions.                           |
| tables | reads `record_tags`/`tags` (or the denormalized `tags` column) at evaluation                                                                                                                                                                                        |
| files  | `apps/workflow/src/engine/validators/builtin.ts`; `apps/workflow/src/engine/operators.ts` (set-operator helper); `libs/shared/enums/src/workflow.enum.ts` (RuleOperator); fact-assembly in `apps/workflow/src/engine/aggregate.ts` / consumers feeding `ctx.record` |
| effort | M                                                                                                                                                                                                                                                                   |

### B6 — Tag RBAC permissions

Seed dotted permissions in the access-control catalog so tag governance is gated:
`tag.create`, `tag.update`, `tag.delete`, `tag.list`, `record.tag.add`, `record.tag.remove`,
`team.tag.manage` (mirrors donor `tag.*` + `jobs.edit.tags.*`). Map to roles
(admin/manager mutate; everyone lists) via `role_permissions`.

| field  | value                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| why    | Tag CRUD and record-tag attach are mutations that must respect RBAC; without permissions any role could rewrite the catalog. |
| tables | `permissions`, `role_permissions` (existing)                                                                                 |
| files  | new migration `0025_tag_permissions.ts` (bulk-insert permissions + mappings); PEP guards on the tag/record-tag controllers   |
| effort | S                                                                                                                            |

### Out of scope (flag + skip)

- **Line-item-level tags** (`job_tags.job_line_item_id`) — our expense/invoice line items don't need
  per-line classification for the access-control demo; header/record-level tagging suffices.
- **Fuzzy line-item↔tag ML matching** (`job_line_item_tag_fuzzy_matches`) — an enrichment-engine feature,
  not access-control; skip.
- **Label-vs-tag dual concept** — collapsed to one "tags" concept (B3.0).
- **Ops/global tags** (`tags.company_id IS NULL`) — donor's platform-operator construct; our tenant
  isolation model makes per-tenant tags the only sensible scope. Skip the null-tenant carve-out.

---

## 4. Migration / sequencing note

Order: **B2 (teams) → B1 (tags catalog + join, with the team FK) → B3 (assignee) → B4 (filters) →
B5 (rule conditions) → B6 (RBAC)**. B1–B3 are additive DDL; the existing `tags` JSONB column stays as a
denormalized read/condition cache synced from `record_tags` on write, so the already-shipped
`add_tag`/`assign_team` path keeps functioning throughout. Add the `record_tags`→`tags` JSONB sync to
each service's `applyRecordUpdate` so the cache never drifts (or treat `record_tags` as source of truth
and drop the JSONB column in a later wave once filters/conditions read the join directly).

**Implemented sequence:** `0023_teams.ts` → `0024_tags.ts` → `0025_record_annotations.ts`, with RBAC
added through `Permission` enum + `0001_system_roles.ts` seeding rather than a separate permission-only
migration. Governance routes, annotation filters, and async writes are default-off behind the
`record.annotations` feature flag.
