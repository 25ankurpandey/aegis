/**
 * Vocabulary for the shared multi-level approval engine (`@aegis/approvals`). One configurable,
 * tenant-scoped, multi-level, hierarchy-aware engine routes approvals for every record type
 * (expense reports, invoices, pay runs, …) instead of each finance service running an
 * independent single-shot approve/reject. See docs/analysis/B1-approvals.md.
 */

/**
 * Legacy per-record decision status (still used by the pre-engine inline `*_approvals` rows in
 * expense/invoice/payroll). The shared engine uses {@link RecordApproverStatus} +
 * {@link ApprovalDecision}. Retained for backward compatibility until those services migrate.
 */
export enum ApprovalStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
  StandBy = 'stand_by',
}

/**
 * How a policy's levels are evaluated.
 * - `sequential`: levels clear one at a time, lowest level first; the chain advances only when the
 *   current level is satisfied (a true approver chain).
 * - `parallel`: all levels are pending at once and the chain completes when `min_approvals`
 *   approvals are recorded (any-of / quorum routing).
 */
export enum ApprovalMode {
  Sequential = 'sequential',
  Parallel = 'parallel',
}

/**
 * What kind of principal an approver slot resolves to. A `user` is a single approver; a `group`
 * expands to its members (any member can clear the slot); a `role` is satisfied by any holder of
 * that role. Mirrors the donor's polymorphic approver membership (user / role / group).
 */
export enum ApproverType {
  User = 'user',
  Group = 'group',
  Role = 'role',
}

/** A single approver's vote on one level (the immutable ledger decision). */
export enum ApprovalDecision {
  Approved = 'approved',
  Rejected = 'rejected',
}

/**
 * The status of one resolved approver slot in a record's chain.
 * - `pending`: awaiting a decision.
 * - `approved` / `rejected`: a vote was recorded for this slot.
 * - `skipped`: the slot was bypassed (e.g. a higher-level rejection short-circuited the chain, or a
 *   threshold/policy rule excluded the level).
 * - `superseded`: the slot was replaced by a re-resolution or an explicit reassignment — it is
 *   retired from the *live* chain (`is_active = false`) but preserved for the audit history so the
 *   full provenance of who-was-asked is never lost (W3-06 unified vote ledger).
 */
export enum RecordApproverStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
  Skipped = 'skipped',
  Superseded = 'superseded',
}

/**
 * Where a policy level sources its approver(s) from (W3-02 / W3-04 / W3-05). The resolver maps each
 * source to one or more concrete approver slots:
 * - `user`: a specific named user (the slot's `approver_id`).
 * - `role`: any holder of a role (the slot routes to the role id; satisfied by any holder).
 * - `group`: an approver_group — expands to its members; ANY member (or `min_approvals` of them)
 *   satisfies the level.
 * - `manager`: the reporting manager OF the requester (one edge up the approval_hierarchy).
 * - `manager_chain`: every manager from the requester up to `depth` levels (a chain of N managers).
 */
export enum ApproverSource {
  User = 'user',
  Role = 'role',
  Group = 'group',
  Manager = 'manager',
  ManagerChain = 'manager_chain',
}

/**
 * Membership kind for an approver group member (polymorphic): a concrete `user` or a `role`
 * (satisfied by any holder). Kept intentionally small for the foundation; the donor additionally
 * supports team / job-owner / persona kinds that later agents can extend onto this enum.
 */
export enum ApproverGroupMemberType {
  User = 'user',
  Role = 'role',
}

/**
 * The record types the shared engine can route. A policy is keyed by `(tenant_id, record_type)`,
 * so adding a new approvable record type is one enum entry + a policy row — no new tables.
 */
export enum ApprovalRecordType {
  ExpenseReport = 'expense_report',
  Invoice = 'invoice',
  PayRun = 'pay_run',
}
