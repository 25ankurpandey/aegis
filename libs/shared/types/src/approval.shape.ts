import type {
  ApprovalMode,
  ApproverType,
  ApprovalDecision,
  RecordApproverStatus,
  ApproverGroupMemberType,
  ApproverSource,
} from '@aegis/shared-enums';

/**
 * Domain contract for the shared multi-level approval engine (`@aegis/approvals`). Persistence row
 * shapes, service inputs, and the resolver interfaces all live here (SPEC §11.2 — no domain types
 * defined inside the lib). The engine, repositories, and consumers import these from
 * `@aegis/shared-types`; nothing approval-domain-typed is declared locally.
 *
 * Money is always integer minor units (SPEC §9). Tenant authority always comes from the RLS-scoped
 * transaction / request context, never from a payload field.
 */
export namespace ApprovalShape {
  /**
   * A money amount in integer MINOR units (SPEC §9). Accepts `bigint`, a decimal `string`
   * (Postgres `BIGINT`/`NUMERIC` columns surface as strings via the driver), or `number` for small
   * values. Threshold routing (W3-03) compares these with `BigInt(...)` so amounts beyond
   * `Number.MAX_SAFE_INTEGER` route to the correct senior level instead of silently misrouting
   * through a lossy `Number()` coercion (BUG-0007). The union is additive — existing `number`
   * callers keep working unchanged.
   */
  export type MinorAmount = bigint | string | number;

  // ---- Persistence row shapes (what repositories return; `*.get({ plain: true })`) ----

  /** A row of the `approval_policies` table — how a record TYPE is approved for one tenant. */
  export interface PolicyRow {
    id: string;
    tenant_id: string;
    record_type: string;
    name: string;
    mode: ApprovalMode;
    /** Minimum approvals required to complete the chain (parallel quorum / sequential = level count). */
    min_approvals: number;
    is_active: boolean;
    /** Open extension seam later agents fill: thresholds, manager-injection flags, SoD rules, etc. */
    config: PolicyConfig;
    created_at?: Date;
    updated_at?: Date;
    created_by?: string | null;
    updated_by?: string | null;
    deleted_at?: Date | null;
  }

  /**
   * Free-form policy configuration. The foundation reads only `levels` (a basic ordered list of
   * approver slots) + `excludeRequester`. The full resolver (W3-02..W3-08) additionally reads each
   * level's `source` (W3-05 manager / W3-04 group / role / user), per-level `mode` + `min_approvals`
   * (W3-08 mixed sequential/parallel), and amount-threshold gates (W3-03). Unknown keys are ignored,
   * so the contract stays open for further extension.
   */
  export interface PolicyConfig {
    /** Ordered approver-LEVEL specs that the resolver materialises into a chain. */
    levels?: PolicyLevelSpec[];
    /** SoD hook: when true, the requester is never placed on (or is skipped from) the chain. */
    excludeRequester?: boolean;
    [key: string]: unknown;
  }

  /**
   * One configured level in a policy. A level can route to a single user/role/group, to the
   * requester's reporting manager, or to a manager chain N levels deep; it can be gated by an amount
   * threshold; and it carries its own mode + quorum so a policy can mix sequential and parallel
   * levels (W3-08). The resolver expands each level into one or more {@link ResolvedSlot}s.
   *
   * Back-compat: a level declared only with `approver_type` + `approver_id` (the foundation shape,
   * no `source`) is treated as a `source: user|role|group` slot per its `approver_type`.
   */
  export interface PolicyLevelSpec {
    level: number;
    /**
     * Where this level sources its approver(s) from (W3-02). When omitted, the resolver derives it
     * from {@link approver_type} for backward compatibility (user→user, role→role, group→group).
     */
    source?: ApproverSource;
    /**
     * The kind of the resolved slot(s). For a static slot this is the principal kind; for a
     * `manager`/`manager_chain` source the resolved slots are always users. Optional when `source`
     * is set (it is inferred).
     */
    approver_type?: ApproverType;
    /**
     * The user id / group id / role id this slot routes to. Required for `user`/`role`/`group`
     * sources; ignored (and may be omitted) for `manager`/`manager_chain` which resolve dynamically.
     */
    approver_id?: string;
    /** Tiebreak order WITHIN a level (parallel slots at the same level). Defaults to `level`. */
    sequence?: number;
    /** For `manager_chain`: how many managers up from the requester to inject (defaults to 1). */
    depth?: number;
    /**
     * Per-level evaluation mode (W3-08). When set it overrides the policy-wide `mode` for THIS level
     * (e.g. a parallel quorum level inside an otherwise sequential chain). Defaults to the policy mode.
     */
    mode?: ApprovalMode;
    /**
     * Minimum approvals to clear THIS level (W3-04 group quorum / W3-08 parallel level). Defaults to
     * 1 (any one resolved approver clears the level). Clamped to the number of slots resolved.
     */
    min_approvals?: number;
    /**
     * Amount-threshold gate (W3-03), integer minor units. The level is INCLUDED only when the
     * record's `amountMinor` is `>= amountMinorMin` (when set) and `< amountMinorMax` (when set).
     * A level with neither bound always applies. Records with no amount fail any `amountMinorMin`
     * gate (a threshold level is conservatively excluded when the amount is unknown).
     */
    amountMinorMin?: MinorAmount;
    amountMinorMax?: MinorAmount;
    /** Restrict the threshold gate to a currency (when set, the level applies only for that currency). */
    currency?: string;
  }

  /** A row of the `approval_hierarchy` table — one tenant manager/reporting edge. */
  export interface HierarchyRow {
    id: string;
    tenant_id: string;
    user_id: string;
    manager_id: string | null;
    /** Depth from the org root (0 = top). Used for manager-based resolution ordering. */
    depth: number;
    created_at?: Date;
    updated_at?: Date;
  }

  /** A row of the `approver_groups` table — a named group of approvers. */
  export interface ApproverGroupRow {
    id: string;
    tenant_id: string;
    name: string;
    is_active: boolean;
    created_at?: Date;
    updated_at?: Date;
    created_by?: string | null;
    updated_by?: string | null;
    deleted_at?: Date | null;
  }

  /** A row of the `approver_group_members` table — polymorphic membership (user | role). */
  export interface ApproverGroupMemberRow {
    id: string;
    tenant_id: string;
    group_id: string;
    member_type: ApproverGroupMemberType;
    member_id: string;
    created_at?: Date;
    updated_at?: Date;
  }

  /** A row of the `record_approvers` table — one resolved slot in a record's chain. */
  export interface RecordApproverRow {
    id: string;
    tenant_id: string;
    record_type: string;
    record_id: string;
    level: number;
    approver_type: ApproverType;
    approver_id: string;
    status: RecordApproverStatus;
    /** Ordering within a level (parallel slots). */
    sequence: number;
    /**
     * Whether this slot is part of the LIVE chain (W3-06). A reassignment / level re-resolution
     * retires the prior slot by flipping `is_active` to false (and stamping its status
     * `superseded`), so the live chain is `WHERE is_active`, while the full who-was-asked history is
     * preserved. Defaults to true.
     */
    is_active: boolean;
    /** The slot that replaced this one when it was superseded (audit back-pointer). */
    superseded_by_id?: string | null;
    created_at?: Date;
    updated_at?: Date;
  }

  /** A row of the `approvals` table — one immutable recorded vote. */
  export interface ApprovalVoteRow {
    id: string;
    tenant_id: string;
    record_type: string;
    record_id: string;
    level: number;
    approver_id: string;
    decision: ApprovalDecision;
    comment?: string | null;
    decided_at: Date;
    created_at?: Date;
  }

  // ---- Service inputs / outputs ----

  /** Input to `ApprovalService.requestApproval`. */
  export interface RequestApprovalInput {
    recordType: string;
    recordId: string;
    /** Optional record amount (integer minor units) for threshold-aware resolution (W3-03). */
    amountMinor?: MinorAmount;
    /** Optional ISO currency code paired with `amountMinor` (gates currency-scoped threshold levels). */
    currency?: string;
    /** The principal that submitted the record for approval (the SoD requester). */
    requestedBy: string;
  }

  /** Input to `ApprovalService.reassign` — retire one approver's pending slot in favour of another (W3-06). */
  export interface ReassignInput {
    recordType: string;
    recordId: string;
    /** The approver currently holding the pending slot to retire. */
    fromApproverId: string;
    /** The approver to route the slot to instead. */
    toApproverId: string;
    /** Who performed the reassignment (audit). */
    reassignedBy: string;
  }

  /** Input to `ApprovalService.decide`. */
  export interface DecideInput {
    recordType: string;
    recordId: string;
    approverId: string;
    decision: ApprovalDecision;
    comment?: string;
  }

  /** The terminal outcome of a chain once it completes. */
  export type ChainOutcome = 'approved' | 'rejected';

  /** Result of `requestApproval` — the materialised chain for the record. */
  export interface RequestApprovalResult {
    recordType: string;
    recordId: string;
    mode: ApprovalMode;
    minApprovals: number;
    chain: RecordApproverRow[];
  }

  /** Result of `decide` — the post-decision chain state. */
  export interface DecisionResult {
    recordType: string;
    recordId: string;
    /** Whether the whole chain has now resolved. */
    completed: boolean;
    /** Set only when `completed` is true. */
    outcome?: ChainOutcome;
    chain: RecordApproverRow[];
  }

  /** Result of `getStatus` — the live chain, the superseded history, plus its vote ledger. */
  export interface ChainStatus {
    recordType: string;
    recordId: string;
    mode: ApprovalMode;
    minApprovals: number;
    completed: boolean;
    outcome?: ChainOutcome;
    /** The LIVE chain (active slots only). */
    chain: RecordApproverRow[];
    /**
     * The FULL chain history — active AND superseded slots (W3-06), so the complete who-was-asked
     * provenance survives reassignments / re-resolutions. Superordinate to `chain`.
     */
    history: RecordApproverRow[];
    votes: ApprovalVoteRow[];
  }

  /**
   * The resolver contract: turn a policy + record context into an ordered set of approver slots.
   * The default resolver implements a basic single/multi-level resolution from `policy.config.levels`;
   * later agents register richer resolvers (threshold-aware, manager-injecting, group-expanding)
   * behind this same interface.
   */
  export interface ResolvedSlot {
    level: number;
    approver_type: ApproverType;
    approver_id: string;
    sequence: number;
  }

  /** Context handed to a resolver. */
  export interface ResolveContext {
    tenantId: string;
    recordType: string;
    recordId: string;
    amountMinor?: MinorAmount;
    /** ISO currency code paired with `amountMinor` (for currency-scoped threshold levels). */
    currency?: string;
    requestedBy: string;
    policy: PolicyRow;
  }
}
