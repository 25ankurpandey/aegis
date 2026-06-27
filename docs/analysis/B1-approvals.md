# B1 — Approval Engine: Aegis vs the domain reference (Reference-Fidelity Audit)

**Track:** B (domain-reference completeness) · **Area:** Approval Engine
**Verdict:** The "shared multi-level approval engine" that Aegis advertises **does not exist**. The seven `TableName` enum entries under `// shared approval engine` are **dead stubs** — no migrations, no models, no services, zero references outside the enum file. What Aegis actually ships is **three independent, single-shot, inline `approve()` calls** (expense, invoice, payroll), each hardcoding `level = 1` and never advancing a chain. The domain reference, by contrast, ships a full configurable, multi-level, hierarchy-aware, threshold-driven approval engine. This is the owner's biggest concern and the owner is **correct**.

---

## 1. What the domain reference actually implements (the reference truth)

the domain reference's approval engine is a first-class subsystem with its own tables, models, and ~20 service modules.

### Tables / migrations (READ-ONLY reference)
- `approval_policies` — `0391_approval_policy.ts` (81 lines). Per-company named policy, `is_default`, `archived`, `currency`, `job_id` + `is_modified_for_job` (job-custom override).
  Model: `libs/document/models/src/approval-policy.model.ts:13`.
- `approver_groups` + `approver_group_members` — `0415_approver_groups.ts` (112 lines).
  Members are **polymorphic**: `user_id | role_id | team_id | job_owner | job_team | job_reviewer | job_business_persona_buyer | job_business_persona_requestor` (`approver-group-member.model.ts:31-72`).
- `job_approval_hierarchy` (levels) — `0230_add_approver_hierarchy.ts`. Approvers ordered by `hierarchy.level` (`get-next-approver.ts:623` — `order: [Sequelize.literal('hierarchy.level')]`).
- `job_approvers` — links a policy → hierarchy level → group, plus per-approver **amount thresholds** (`threshold: none|more_than|between`, `threshold_amount1/2`, `version`, `assignment_type`) — `job-approver.model.ts:45-92`.
- `job_approvals` — the per-decision vote ledger: `approval_status (bool)`, `active`, `approval_level`, `comment_id`, `user_id` — `job-approval.model.ts:13`, migration `0067_job_approvals_table.ts`.
- `approval_progress_log` — state-machine progress per level/group with `entered_at/exited_at`, `is_dynamic`, `approval_type (static|dynamic)`, `dynamic_user_id` — `approval-progress-log.model.ts:13`, migration `0546_approval_progress_log.ts` (137 lines).
- `email_approvals` — out-of-band approve-by-email.

### Service logic (the capabilities)
- **Multi-level sequential chain resolution:** `job-approver/get-next-approver.ts` — `getNextPendingApprover()` (line 250) walks approvers ordered by hierarchy level, skips levels already satisfied (`isApproverLevelRequired`, line 406), and returns the next pending approver + whether `hasNextApprover` (line 213). This is a true chain, not a single gate.
- **Configurable policy per tenant + fallback/default:** `getApproversList()` resolves the job's assigned policy and falls back to the company default policy (`get-next-approver.ts:580`, `getActiveApprovals`, `is_default`). Policies are CRUD'd via `approval-policy/{create,update,get,reassign-approvers,reassign-parent-policy}.ts`.
- **Amount thresholds (none / more_than / between) with multi-currency conversion:** `isApproverThresholdNeedApproval()` + `isApproverRequired()` (`get-next-approver.ts:121-211`) — an approver level only fires if the job amount crosses the configured threshold, with full currency conversion against base currency.
- **Manager / reporting-manager hierarchy resolution (dynamic approvers):** `job-approver/utils.ts:361 addManagerApproverIfRequired()` / `addReportingManagerIfRequired()` (line 407) injects the submitter's reporting manager as a dynamic approver level when an approval-limit config is active (`assign-user-approval-limit.ts`, `user-hierarchy/*`). Manager approvals are stored at the same level (`get-next-approver.ts:431` comment).
- **Approver groups (users/roles/teams/job-owner/reviewer/personas):** group members expand to candidate user IDs at resolution time; any one member satisfying the level can clear it (`getNextPendingApprover` filters `alreadyApprovedUserIds`, line 299).
- **Delegation / re-assignment / add-approver at runtime:** `approval-policy/reassign-approvers.ts`, `add-next-approvers.ts`, `copy-policy-as-job-custom.ts` — clone the policy as a job-custom copy, re-target an approver level, write a `JobPolicyReAssignApprover` activity, re-send approver emails, and re-log progress. This is the reference's delegation/escalation mechanism.
- **Audit trail:** every mutation writes a typed `job_activity` (`JobPolicyAddApprover`, `JobPolicyReAssignApprover`, etc.) plus the `approval_progress_log` and the `job_approvals` vote ledger (active/inactive rows so a rejection invalidates prior approvals — `getActiveApprovals`, `is-approval-complete.ts:8`).
- **Completion detection:** `is-approval-complete.ts:26` checks every required approver level is satisfied before the job advances.
- **Parallel pre-approval:** `job-reviewer/*` (reviewers run alongside the sequential approver chain).

---

## 2. What Aegis actually implements (our truth)

### The "shared approval engine" is vaporware
`libs/shared/enums/src/table-name.enum.ts:27-33` declares, under `// shared approval engine`:
`ApprovalPolicies, ApprovalHierarchy, ApproverGroups, ApproverGroupMembers, RecordApprovers, Approvals, ApprovalProgressLog`.

**Evidence they are unused stubs:**
- `grep` for every one of those identifiers across `apps/**` + `libs/**` (excluding the enum file) returns **zero hits**.
- No migration in `apps/cli/src/migrations/**` creates any of these tables (migrations are `0001_identity … 0010_tenant_config`; none is an approval migration).
- No Sequelize model defines any of them (`find -iname '*approv*'` yields only `expense-approval.model.ts` and `invoice-approval.model.ts`).
- `approval.enum.ts` defines `ApproverThreshold`, `ApproverMemberKind {User,Role,Team,JobOwner,Manager}`, `ApprovalType {Static,Dynamic}` — **direct copies of the domain reference's vocabulary** — but **nothing consumes them**. They are aspirational enums describing an engine that was never built.

### What we actually run: three independent single-shot approvals
- **Expense** — `apps/expense/src/services/expense.service.ts:201 approveReport()`: one `APPROVALS → APPROVED` transition gated by a role-keyed state map (`assertTransition(..., 'manager')`), writes **one** `expense_approvals` row with `level: 1` **hardcoded** (line 226), emits `ExpenseApproved`, pushes to ERP. No next-approver, no chain, no policy lookup, no thresholds, no groups.
- **Invoice** — `apps/invoice/src/services/invoice.service.ts:200 approve()`: requires status `ForApproval`, writes one `invoice_approvals` row with `approval_level: input.approvalLevel ?? 1` (line 221), immediately sets `Approved`. The `approvalLevel` is caller-supplied and never validated against a chain; nothing computes "is there a next level?".
- **Payroll** — `apps/payroll/src/services/pay-run.service.ts:136 approve()`: `Calculated → Approved`, enforces **maker-checker SoD** (`run.created_by === approver` → forbidden, line 144). This is genuinely good, but it is a single approval, not a chain.

### The schema hints at a chain that the code never walks
`apps/cli/src/migrations/0003_expense.ts:162` and `0002_invoice.ts:162` both add a `level`/`approval_level` column (default `1`, check `>= 1`). The column exists; **no code path ever increments it or routes to a second approver.** It is a multi-level schema with single-level behavior.

---

## 3. Capability-by-capability divergence matrix

| Capability | the domain reference | Aegis | Classification |
|---|---|---|---|
| Multi-level sequential chain | Yes (`get-next-approver.ts`) | No — single inline approve | **missing** (critical) |
| Configurable approval policy per tenant | Yes (`approval_policies`, default/fallback, job-custom) | No — role-keyed state map in code | **missing** (high) |
| Amount thresholds (none/more_than/between) | Yes, currency-aware | No | **missing** (high) |
| Manager / reporting-manager resolution | Yes (`addManagerApproverIfRequired`) | No (expense uses a static "manager-of-submitter" role check, not hierarchy) | **missing** (high) |
| Approver groups (user/role/team/owner/reviewer/persona) | Yes (`approver_groups` + polymorphic members) | No (enum stub only) | **missing** (high) |
| Delegation / runtime re-assignment / add-approver | Yes (`reassign-approvers`, `add-next-approvers`) | No | **missing** (medium) |
| Escalation | Approval-limit-driven manager insertion | No | **missing** (medium) |
| Parallel vs sequential | Sequential chain + parallel reviewers | Single gate only | **missing** (medium) |
| Approval audit trail | Vote ledger (`active` rows) + progress log + typed activities | Per-service `*_approvals` row + activity row + `AuditLogger` | **partial / regression** (medium) |
| Rejection invalidates prior approvals | Yes (`getActiveApprovals`) | No (no chain to invalidate) | **missing** (medium) |
| Maker-checker / SoD | Implicit (approver ≠ submitter via levels) | **Yes, explicit in payroll** (`pay-run.service.ts:144`) | **justified** (Aegis improvement, payroll only) |
| Tenant isolation (RLS) on approval rows | App-level company_id scoping | **Postgres RLS** on `*_approvals` (`0003_expense.ts:220`) | **justified** (Aegis improvement) |

---

## 4. Classification summary

- **No "justified" replacement of the engine.** The two genuine Aegis improvements (explicit payroll SoD; RLS-enforced tenant isolation on approval rows) are real and worth keeping — but they are orthogonal to, and do not substitute for, a multi-level engine. The owner's instinct is right: we did **not** match the reference.
- **The dominant finding is `missing`, not `regression`** — because Aegis never had a chain to lose. The enum stubs make it *look* implemented (and likely fooled a prior reviewer / the schema), which is the dangerous part: a reader of `table-name.enum.ts` reasonably concludes a shared engine exists.
- **One real regression:** the approval **audit/decision semantics** are weaker — no `active`/superseded vote model, so a rejection-then-resubmit cycle has no first-class representation; each service reinvents a thinner trail.

---

## 5. Build plan — a real shared approval engine (`@aegis/approvals`)

Build it **once**, as a shared lib + a set of `0011_approvals.ts` migrations, consumed by expense/invoice/payroll via a polymorphic `(tenant_id, resource_type, resource_id)` key. Mirror the domain reference's model but keep Aegis's RLS + explicit SoD wins.

### Tables (new migration `apps/cli/src/migrations/0011_approvals.ts`, all tenant-scoped + `rlsPolicyStatements`)
1. `approval_policies` — `tenant_id, name, currency, is_default, archived, resource_type` (which domain it governs). Default/fallback per tenant per resource_type.
2. `approval_hierarchy` — `tenant_id, policy_id, level (int)` (the ordered rungs).
3. `approver_groups` — `tenant_id, policy_id, hierarchy_level_id, threshold (enum), threshold_amount1/2`.
4. `approver_group_members` — polymorphic: `group_id, member_kind (user|role|team|job_owner|manager), user_id?|role_id?|team_id?`. Reuse `ApproverMemberKind` from `approval.enum.ts` (finally consume it).
5. `record_approvers` — materialized per-record resolved chain (snapshot of who must approve, so a mid-flight policy edit doesn't silently re-route): `tenant_id, resource_type, resource_id, level, group_id, resolved_user_ids[], status`.
6. `approvals` — the decision/vote ledger: `tenant_id, resource_type, resource_id, level, approver_id, decision (approved|rejected), active (bool), comment, decided_at`. `active=false` supersedes on rejection (port `getActiveApprovals`).
7. `approval_progress_log` — `tenant_id, resource_type, resource_id, level, group_id, entered_at, exited_at, approval_type (static|dynamic), dynamic_user_id`.

### Services (`libs/approvals/src`)
- `PolicyResolver.resolve(resourceType, resourceId, amount, currency)` → ordered levels after applying thresholds + currency conversion (port `isApproverRequired`).
- `ApproverResolver` → expand groups to user IDs; inject reporting manager when an approval-limit config is on (port `addManagerApproverIfRequired`; needs `user_hierarchy` which Aegis already declares as `UserHierarchy` table — wire it).
- `ApprovalEngine.getNextApprover(resource)` (port `getNextPendingApprover`), `.recordDecision(resource, approverId, decision, comment)`, `.isComplete(resource)` (port `is-approval-complete`).
- `Delegation.reassign(resource, level, newApprovers)` + `addApprover(resource, afterLevel, approvers)` — job-custom override semantics, write progress + audit.
- Keep payroll's explicit SoD as an `ApprovalEngine` invariant (approver ∉ makers).

### Events (`@aegis/events`)
- `approval.level.entered`, `approval.recorded`, `approval.rejected`, `approval.completed`, `approval.reassigned`. Services subscribe to `approval.completed` to run their existing terminal action (ERP push for expense/invoice; disburse-eligibility for payroll).

### Consumption / migration of existing services
- Replace `expense.approveReport`, `invoice.approve`, `payroll.approve` inline logic with `ApprovalEngine.recordDecision(...)` + a subscriber on `approval.completed`.
- Keep the per-service `*_approvals` tables only as deprecated read-models, or migrate them into the shared `approvals` table behind `resource_type`.
- **First step regardless:** either build the engine or **delete the seven dead enum stubs** + the `ApproverThreshold/ApproverMemberKind/ApprovalType` enums so the schema stops lying about an engine that isn't there.

### Effort
Full engine: **XL** (new lib + 7 tables + resolver/threshold/manager logic + 3 service rewrites). Minimum honesty fix (delete stubs or document them as roadmap): **S**.
