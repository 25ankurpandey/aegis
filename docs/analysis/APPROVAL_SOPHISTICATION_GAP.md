# Approval + Rules-Engine Sophistication Gap

**Area:** approval engine (`libs/approvals`) + workflow rule engine (`apps/workflow`)
**Scope:** expense report / invoice / pay-run records, RBAC/ABAC, the approval chain engine, and the
workflow rule engine. Donor system (the production finance platform we synthesised from) referenced
here for comparison only.
**Verdict in one line:** our engine is already strong on *chain mechanics* (modes, quorum, thresholds,
manager chains, delegation, SoD). The real gaps are in *who can be an approver* (team / record-relative
sources), *per-approver thresholds inside a level*, and *what the rule engine can read* (tags/labels and
requestor as conditionable fields). Nothing about escalation/timeouts is recommended — the donor does
not have it either, so it would be gold-plating, not parity.

---

## 1. What we ALREADY have (do NOT re-recommend)

The following are implemented and tested today. They are listed so later readers do not re-file them as
gaps.

| Capability | Where | Notes |
|---|---|---|
| Per-tenant policy, keyed `(tenant_id, record_type)`, with JSONB `config` extension seam | `libs/approvals/src/models/approval-policy.model.ts`; `approval.service.ts:369` `resolvePolicy` | Built-in default policy synthesised when a tenant has none — engine never throws on an unconfigured type. |
| Sequential **and** parallel modes, **mixed per-level** (a parallel quorum level inside a sequential chain) | `approval.service.ts:387` `levelMode`, `:399` `levelQuorum` | Per-level `mode` overrides the policy mode (W3-08). |
| Amount-threshold routing per level, **currency-scoped**, lossless `bigint` minor-unit comparison | `resolver.ts:238` `thresholdApplies`; BUG-0007 fix | `amountMinorMin` / `amountMinorMax` / `currency` gate. Unknown amount conservatively excludes a lower-bound (senior) level. |
| Manager (one edge up) and **manager-chain** (N levels) approver sources | `resolver.ts:185-191`; `HierarchyPort` | Walks the tenant reporting graph. |
| Approver **group** expansion (user/role members) with **quorum** (`min_approvals`, any-of) | `resolver.ts:180-184`; `levelQuorum` | Group expands to user members; level clears on quorum. |
| Role-typed slots (satisfied by any holder of the role) | `resolver.ts:178` | `ApproverType.Role`. |
| Separation-of-Duties: requester excluded from the chain (`excludeRequester`), empties → auto-complete | `resolver.ts:137`, `approval.service.ts:136` | SoD hook in the resolver. |
| Delegation / **reassign + supersede** with full who-was-asked history preserved | `approval.service.ts:256` `reassign`; `RecordApproverStatus.Superseded`, `is_active`, `superseded_by_id` | Retired slots kept for audit (W3-06); BUG-0006 guards duplicate live slots. |
| Immutable, append-only **vote ledger with comments**, no-double-vote (DB unique index + guard) | `approval.service.ts:208` `votes.append`; `ApprovalVoteRow.comment` | Rejection short-circuits the whole chain. |
| Concurrency-safe decide/reassign (per-record advisory lock) | `approval.service.ts:178`, BUG-0004 | Prevents double-complete / stalled quorum. |
| Approver **inbox** (live pending slots for a principal, optionally by record type) | `approval.service.ts:321` `listPendingForApprover` | The "awaiting me" surface. |
| Full status surface: live chain + superseded history + vote ledger + outcome | `approval.service.ts:329` `getStatus`; `ChainStatus` | History is superordinate to the live chain. |
| Rule engine: trigger event + ordered steps + AND/OR predicate groups + typed actions, per-run audit | `apps/workflow/src/engine/evaluate-step.ts`, `models/rule.model.ts`, `RuleRunStatus` | Optimistic-locked, soft-deleted rule aggregate. |
| Rule actions: auto_approve (gated), assign_approval_policy, assign_team, add_tag, notify, push_to_connector | `apps/workflow/src/engine/actions/builtin.ts` | Each emits a scoped follow-on event; owning service stays the data owner. |
| Money predicates in lossless `bigint` minor units; `between`/comparison/`in`/`contains` operators exist | `engine/operators.ts`, `engine/validators/builtin.ts` | Registry is extensible (`registerValidator`). |

This is a genuinely production-shaped engine. The gaps below are narrow and specific.

---

## 2. What the donor has that we LACK and that fits our use case

Read against the donor's `job_approver` / `approver_group_member` / `approval_progress_log` /
`rule` surfaces. Each item is scoped to our records (expense/invoice/pay-run) and to RBAC/ABAC. Items
the donor *also* lacks (escalation, SLA timeouts, auto-escalate, reminders) are deliberately **excluded**
— see §3.

### 2.1 Team-based approver resolution (HIGH value, fits us)
The donor's approver-group member is polymorphic across **`user_id | role_id | team_id`**
(`approver-group-member.shape.ts`). We support user and role members only — our enum
`ApproverGroupMemberType` is `{ User, Role }` and its own doc-comment admits *"the donor additionally
supports team / job-owner / persona kinds that later agents can extend."* A level cannot today say
"approved by anyone on the owning team." This is the single most common real policy ("the Finance team
approves invoices") and we have a team concept already (`assign_team` action, `team_id` on records).

### 2.2 Record-relative ("dynamic") approver sources (HIGH value)
The donor resolves approvers *relative to the record*, not just to a static principal or the requester's
manager: **job owner**, **job team**, **job reviewer**, and business personas **buyer** / **requestor**
(`approver-group-member.shape.ts` flags; `JobApproverOwnershipCategory`, `JobApproverBusinessPersonaCategory`).
Our `ApproverSource` is `{ User, Role, Group, Manager, ManagerChain }` — all keyed off the *requester* or a
static id. We cannot express "must be approved by the record's owner's team" or "by the named requestor on
the record." For expense/invoice this maps cleanly to *owner / owning-team / submitter* approver slots.
(The donor's `approval_progress_log.is_dynamic` + `dynamic_user_id` exists precisely to record that a slot
was resolved dynamically at decision time.)

### 2.3 Per-approver amount threshold *inside* a level (MEDIUM value)
We gate an entire **level** by amount (`thresholdApplies`). The donor additionally gates each *individual
approver* with `threshold ∈ {None, MoreThan, Between}` + `threshold_amount1/2`
(`job-approver.enum.ts`, `get-next-approver.ts` `isApproverThresholdNeedApproval`). This expresses
"within the manager group, only the manager whose approval limit covers this amount is required" — i.e. an
approval-limit-per-person model, distinct from our per-level tier. Relevant for expense reports where
different managers carry different signing limits.

### 2.4 Rule conditions on tags / labels / requestor (MEDIUM value, small effort)
The donor's rule step queries include `tags`, `gl_code`, `expense_type`, `requestor`, `issues`
(`ValidRuleStepQuery` in `rule.enum.ts`). Our validator registry *supports* the operators (`In`,
`Contains`) but only **registers** fixed header fields: `amount, status, vendor, category, owner_user_id,
team_id, currency, record_type` (`engine/validators/builtin.ts`). There is **no `tags` validator** — a
rule cannot fire on "record is tagged `travel`" even though we have an `add_tag` action that writes tags,
and `scalarValidator` uses strict `===` so it would not do array membership anyway. Likewise no
`requestor` / submitter field. This is an asymmetry in our own engine (we can *set* tags but not *read*
them in a condition) more than a donor-only feature.

### 2.5 assign_reviewer rule action (LOW-MEDIUM value)
The donor has a distinct `JobReviewerAssignment` rule action and a reviewer is a first-class
pre-approval role (`RuleAction.JobReviewerAssignment`, `JobReviewerOptionType`). We have `assign_team`
and `assign_approval_policy` but no notion of attaching a reviewer (a non-deciding reviewer who must
look before the approval chain). Only worth doing if product wants a review-then-approve step; otherwise
a reviewer can be modelled as level-0 approver group.

### 2.6 Per-level "currently sitting at" progress surfacing (LOW value)
The donor keeps an `approval_progress_log` with `entered_at` / `exited_at` per level/approver so the UI
can show "this has been waiting at level 2 since Tuesday." We can *derive* the current level from the
live chain + vote timestamps (`getStatus`), so this is a surfacing/denormalisation nicety, not a missing
capability. Listed for completeness; low priority.

---

## 3. Explicitly NOT recommended (avoid gold-plating)

- **Escalation / SLA timeouts / auto-escalate / reminder nudges.** The donor does **not** implement
  these (grep across the donor's approval services + topic consumers finds no escalation/timeout/reminder
  logic). Building them would be net-new scope, not parity, and is not needed for our use case.
- **parallel-any vs parallel-all nuance.** Already covered: `levelQuorum` gives any-one (default),
  N-of-M (`min_approvals`), and all (sequential level = slot count). No gap.
- **Conditional / branching routing as a separate feature.** We already branch by amount/currency
  threshold per level. The donor's "conditional routing" is exactly its per-approver threshold (§2.3) +
  dynamic sources (§2.2); folded into those items rather than filed twice.
- **Approval comments/history.** Already have an immutable comment-carrying vote ledger + superseded
  history (`getStatus`). Only §2.6 (progress timestamps) is even arguably missing, and it is derivable.

---

## 4. Backlog (genuinely-missing, use-case-relevant only)

Ordered by value. Effort is rough engineer-days for the backend slice only (no UI).

1. **Team-source approver resolution** — §2.1
2. **Record-relative (dynamic) approver sources: owner / owning-team / requestor** — §2.2
3. **Rule conditions on tags + requestor** — §2.4
4. **Per-approver amount threshold inside a level** — §2.3
5. **assign_reviewer rule action** — §2.5 (only if product wants reviewers; else skip)
6. **Per-level progress timestamps** — §2.6 (optional; derivable today)
