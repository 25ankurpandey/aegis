import { inject, optional } from 'inversify';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';
import { ErrUtils, RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import {
  ApprovalMode,
  ApprovalDecision,
  RecordApproverStatus,
} from '@aegis/shared-enums';
import { ApprovalShape } from '@aegis/shared-types';
import {
  makeEnvelope,
  stageOutboxEvent,
  EventTopic,
  type PayloadOf,
} from '@aegis/events';
import { provideSingleton } from './ioc/container';
import { PolicyRepository } from './repositories/policy.repository';
import { RecordApproverRepository } from './repositories/record-approver.repository';
import { VoteRepository } from './repositories/vote.repository';
import { LockRepository } from './repositories/lock.repository';
import { HierarchyRepository } from './repositories/hierarchy.repository';
import { ApproverGroupRepository } from './repositories/approver-group.repository';
import { PolicyApproverResolver, type ApproverResolver } from './resolver';

/**
 * The shared multi-level approval engine. One configurable, tenant-scoped engine routes approvals
 * for every record type (expense reports, invoices, pay runs, …) keyed by a polymorphic
 * `(record_type, record_id)`, replacing the three independent single-shot inline approvals.
 *
 * Lifecycle:
 *  - {@link requestApproval} resolves the applicable per-tenant policy (W3-02), RESOLVES the approver
 *    chain via the {@link PolicyApproverResolver} — amount thresholds (W3-03), manager / manager-chain
 *    sources (W3-05), approver-group expansion + quorum (W3-04) — writes the `record_approvers`
 *    chain, and stages `ApprovalRequested` for the approvers eligible to act now, all in one
 *    RLS-scoped atomic transaction.
 *  - {@link decide} appends an immutable vote, advances the chain honouring each level's own mode +
 *    quorum (W3-08: sequential advances level-by-level; parallel completes a level on its
 *    `min_approvals`), short-circuits on any rejection, and stages `ApprovalCompleted` when the chain
 *    resolves.
 *  - {@link reassign} retires one pending approver's slot and routes the level to another approver,
 *    superseding the prior slot while keeping the full who-was-asked history (W3-06).
 *  - {@link getStatus} returns the live chain, the superseded history, and the vote ledger.
 *
 * Invariants: an approver cannot vote twice (DB unique index + an explicit guard); a rejection
 * short-circuits the chain; every state change is tenant-scoped and atomic; the requester can be
 * excluded by policy (the SoD hook, applied in the resolver); the `approvals` ledger is immutable +
 * append-only and the retired chain rows are never deleted (W3-06).
 */
@provideSingleton(ApprovalService)
export class ApprovalService {
  /** Optional override resolver. When unset, a per-request {@link PolicyApproverResolver} is built. */
  private resolverOverride: ApproverResolver | null = null;
  private readonly hierarchy: HierarchyRepository;
  private readonly groups: ApproverGroupRepository;
  private readonly locks: LockRepository;

  constructor(
    @inject(PolicyRepository) private readonly policies: PolicyRepository,
    @inject(RecordApproverRepository) private readonly chain: RecordApproverRepository,
    @inject(VoteRepository) private readonly votes: VoteRepository,
    @optional() @inject(HierarchyRepository) hierarchy?: HierarchyRepository,
    @optional() @inject(ApproverGroupRepository) groups?: ApproverGroupRepository,
    @optional() @inject(LockRepository) locks?: LockRepository,
  ) {
    this.hierarchy = hierarchy ?? new HierarchyRepository();
    this.groups = groups ?? new ApproverGroupRepository();
    this.locks = locks ?? new LockRepository();
  }

  /** Override the chain resolver (extension seam / tests). Pass `null` to restore the default. */
  useResolver(resolver: ApproverResolver | null): void {
    this.resolverOverride = resolver;
  }

  /** The resolver for this request: the explicit override, else the full policy resolver bound to `t`. */
  private resolverFor(t: Transaction): ApproverResolver {
    return this.resolverOverride ?? new PolicyApproverResolver(this.hierarchy, this.groups, t);
  }

  /**
   * Materialise the approver chain for a record and notify the first approvers. Idempotent: if a live
   * chain already exists for the record it is returned unchanged (re-request is a no-op).
   */
  async requestApproval(
    input: ApprovalShape.RequestApprovalInput,
  ): Promise<ApprovalShape.RequestApprovalResult> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      // Idempotency: never re-route an in-progress approval.
      if (await this.chain.existsForRecord(input.recordType, input.recordId, t)) {
        const existing = await this.chain.listForRecord(input.recordType, input.recordId, t);
        const policy = await this.resolvePolicy(input.recordType, t);
        return {
          recordType: input.recordType,
          recordId: input.recordId,
          mode: policy.mode,
          minApprovals: policy.min_approvals,
          chain: existing,
        };
      }

      const policy = await this.resolvePolicy(input.recordType, t);
      const slots = await this.resolverFor(t).resolve({
        tenantId,
        recordType: input.recordType,
        recordId: input.recordId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        requestedBy: input.requestedBy,
        policy,
      });

      // Persist the resolved chain.
      const created: ApprovalShape.RecordApproverRow[] = [];
      for (const slot of slots) {
        const row = await this.chain.create(
          {
            tenant_id: tenantId,
            record_type: input.recordType,
            record_id: input.recordId,
            level: slot.level,
            approver_type: slot.approver_type,
            approver_id: slot.approver_id,
            status: RecordApproverStatus.Pending,
            sequence: slot.sequence,
          },
          t,
        );
        created.push(row);
      }

      // An empty chain (e.g. SoD excluded the only approver, or thresholds excluded every level)
      // auto-completes as approved.
      if (created.length === 0) {
        await this.emitCompleted(input.recordType, input.recordId, 'approved', input.requestedBy, t);
        return {
          recordType: input.recordType,
          recordId: input.recordId,
          mode: policy.mode,
          minApprovals: policy.min_approvals,
          chain: [],
        };
      }

      // Notify the approvers eligible to act now: every slot at the first level (parallel and
      // sequential alike notify the lowest level first; sequential advances level-by-level on decide).
      const firstLevel = Math.min(...created.map((r) => r.level));
      for (const slot of created.filter((r) => r.level === firstLevel)) {
        await this.stageApprovalRequested(slot, input.requestedBy, t);
      }

      return {
        recordType: input.recordType,
        recordId: input.recordId,
        mode: policy.mode,
        minApprovals: policy.min_approvals,
        chain: created,
      };
    });
  }

  /**
   * Record one approver's decision and advance the chain. Enforces no-double-vote; a rejection
   * short-circuits the chain to `rejected`; otherwise completion is evaluated against the policy +
   * per-level mode (sequential advance vs parallel quorum). Emits `ApprovalCompleted` exactly once
   * when the chain reaches a terminal state.
   */
  async decide(input: ApprovalShape.DecideInput): Promise<ApprovalShape.DecisionResult> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      // BUG-0004: serialise concurrent decisions on this record. Take a transaction-scoped advisory
      // lock keyed on (record_type, record_id) BEFORE reading the chain, so two concurrent approvers
      // on a parallel quorum level can't both miss quorum (chain stalls) or both complete (double
      // ApprovalCompleted). The second voter blocks until the first commits, then reads a serialised,
      // post-first-vote view. Held until tx end; does not change @aegis/db isolation.
      await this.locks.acquireRecordLock(input.recordType, input.recordId, t);

      const chain = await this.chain.listForRecord(input.recordType, input.recordId, t);
      if (chain.length === 0) {
        throw ErrUtils.notFound('No approval chain exists for this record');
      }

      // The slot this approver owns and that is still actionable (pending).
      const slot = chain.find(
        (r) => r.approver_id === input.approverId && r.status === RecordApproverStatus.Pending,
      );
      if (!slot) {
        // Either not an approver for this record, or already decided / skipped.
        const already = chain.find((r) => r.approver_id === input.approverId);
        if (already) {
          throw ErrUtils.conflict('Approver has already acted on this record');
        }
        throw ErrUtils.forbidden('Principal is not a pending approver for this record');
      }

      // No-double-vote guard (defence-in-depth alongside the DB unique index).
      if (
        await this.votes.hasVoted(input.recordType, input.recordId, slot.level, input.approverId, t)
      ) {
        throw ErrUtils.conflict('Approver has already voted at this level');
      }

      const policy = await this.resolvePolicy(input.recordType, t);

      // Append the immutable vote.
      await this.votes.append(
        {
          tenant_id: tenantId,
          record_type: input.recordType,
          record_id: input.recordId,
          level: slot.level,
          approver_id: input.approverId,
          decision: input.decision,
          comment: input.comment ?? null,
          decided_at: new Date(),
        },
        t,
      );

      // Mark the slot per the decision.
      await this.chain.setStatus(
        slot.id,
        input.decision === ApprovalDecision.Approved
          ? RecordApproverStatus.Approved
          : RecordApproverStatus.Rejected,
        t,
      );

      // Rejection short-circuits the whole chain.
      if (input.decision === ApprovalDecision.Rejected) {
        await this.chain.skipRemaining(input.recordType, input.recordId, t);
        await this.emitCompleted(input.recordType, input.recordId, 'rejected', input.approverId, t);
        return this.decisionResult(input.recordType, input.recordId, true, 'rejected', t);
      }

      // Approval: evaluate completion against the policy + per-level mode.
      const completed = await this.evaluateCompletion(policy, input.recordType, input.recordId, slot, t);
      if (completed) {
        await this.chain.skipRemaining(input.recordType, input.recordId, t);
        await this.emitCompleted(input.recordType, input.recordId, 'approved', input.approverId, t);
        return this.decisionResult(input.recordType, input.recordId, true, 'approved', t);
      }

      return this.decisionResult(input.recordType, input.recordId, false, undefined, t);
    });
  }

  /**
   * Reassign one pending approver's slot to another approver (W3-06). The prior slot is SUPERSEDED
   * (retired from the live chain, status `superseded`, `is_active=false`) and a fresh pending slot is
   * created at the same level for the new approver, back-pointed from the retired row. The vote
   * ledger is untouched (nothing was voted). Returns the live chain after the swap.
   */
  async reassign(input: ApprovalShape.ReassignInput): Promise<ApprovalShape.DecisionResult> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      // Serialise with concurrent decide()/reassign() on the same record (shares BUG-0004's lock key).
      await this.locks.acquireRecordLock(input.recordType, input.recordId, t);

      const chain = await this.chain.listForRecord(input.recordType, input.recordId, t);
      if (chain.length === 0) {
        throw ErrUtils.notFound('No approval chain exists for this record');
      }
      const slot = chain.find(
        (r) => r.approver_id === input.fromApproverId && r.status === RecordApproverStatus.Pending,
      );
      if (!slot) {
        throw ErrUtils.conflict('No pending slot for that approver to reassign');
      }
      if (input.toApproverId === input.fromApproverId) {
        throw ErrUtils.conflict('Cannot reassign a slot to the same approver');
      }

      // BUG-0006: reject when the target already holds a LIVE slot at this level — a duplicate pending
      // slot bypasses the resolver's per-level dedup and can deadlock a sequential level (two pending
      // rows the same approver must each clear). The retired from-slot would also leave the target
      // double-listed. Surface a conflict instead of silently creating the duplicate.
      const duplicate = chain.find(
        (r) =>
          r.level === slot.level &&
          r.approver_id === input.toApproverId &&
          r.status !== RecordApproverStatus.Superseded,
      );
      if (duplicate) {
        throw ErrUtils.conflict(
          'Target approver already holds a live slot at this level',
        );
      }

      // Create the replacement slot first so the retired row can point at it.
      const replacement = await this.chain.create(
        {
          tenant_id: tenantId,
          record_type: input.recordType,
          record_id: input.recordId,
          level: slot.level,
          approver_type: slot.approver_type,
          approver_id: input.toApproverId,
          status: RecordApproverStatus.Pending,
          sequence: slot.sequence,
        },
        t,
      );
      await this.chain.supersede(slot.id, replacement.id, t);

      // Notify the new approver (they are now eligible to act in place of the retired one).
      await this.stageApprovalRequested(replacement, input.reassignedBy, t);

      return this.decisionResult(input.recordType, input.recordId, false, undefined, t);
    });
  }

  /**
   * The live, still-PENDING approval slots a principal currently owns — their "approvals inbox".
   * Optionally narrowed to one record type (e.g. `ApprovalRecordType.ExpenseReport`). Tenant-scoped.
   * Because the chain advances level-by-level, a slot only appears here once its level is active and
   * the approver has not yet voted, so this is exactly the set of records awaiting THIS user.
   */
  async listPendingForApprover(
    approverId: string,
    recordType?: string,
  ): Promise<ApprovalShape.RecordApproverRow[]> {
    return withTenantTransaction((t) => this.chain.listPendingForApprover(approverId, recordType, t));
  }

  /** The current live chain + superseded history + vote ledger for a record. */
  async getStatus(recordType: string, recordId: string): Promise<ApprovalShape.ChainStatus> {
    return withTenantTransaction(async (t) => {
      const chain = await this.chain.listForRecord(recordType, recordId, t);
      const history = await this.chain.listHistoryForRecord(recordType, recordId, t);
      const votes = await this.votes.listForRecord(recordType, recordId, t);
      const policy = await this.resolvePolicy(recordType, t);

      const rejected = chain.some((r) => r.status === RecordApproverStatus.Rejected);
      let completed = false;
      let outcome: ApprovalShape.ChainOutcome | undefined;
      if (rejected) {
        completed = true;
        outcome = 'rejected';
      } else if (chain.length > 0 && this.chainSatisfied(policy, chain)) {
        completed = true;
        outcome = 'approved';
      }

      return {
        recordType,
        recordId,
        mode: policy.mode,
        minApprovals: policy.min_approvals,
        completed,
        outcome,
        chain,
        history,
        votes,
      };
    });
  }

  // ---- internals ----

  /**
   * Resolve the active per-tenant policy for a record type (W3-02), or synthesise a built-in DEFAULT
   * single-level policy when the tenant has not configured one. The default policy carries no
   * `levels`, so the resolver yields an empty chain (the engine then auto-completes). Keeping a
   * non-null default means the engine never throws on an unconfigured type.
   */
  private async resolvePolicy(
    recordType: string,
    t: Transaction,
  ): Promise<ApprovalShape.PolicyRow> {
    const configured = await this.policies.findActiveForRecordType(recordType, t);
    if (configured) return configured;
    return {
      id: `default:${recordType}`,
      tenant_id: RequestContext.tenantId(),
      record_type: recordType,
      name: 'default',
      mode: ApprovalMode.Sequential,
      min_approvals: 1,
      is_active: true,
      config: {},
    };
  }

  /** The effective mode for a chain LEVEL (W3-08): the level spec's own mode, else the policy mode. */
  private levelMode(policy: ApprovalShape.PolicyRow, level: number): ApprovalMode {
    const spec = (policy.config?.levels ?? []).find((l) => l.level === level);
    return spec?.mode ?? policy.mode;
  }

  /**
   * Minimum approvals to clear a chain LEVEL (W3-08 / W3-04 group quorum). A parallel level uses the
   * level spec's `min_approvals` (clamped to its slot count, default 1 = any-one); a sequential level
   * requires every slot at the level. The policy-level `min_approvals` is a parallel-policy quorum
   * across the (single) level when no per-level value is configured.
   */
  private levelQuorum(
    policy: ApprovalShape.PolicyRow,
    level: number,
    slotCount: number,
  ): number {
    const spec = (policy.config?.levels ?? []).find((l) => l.level === level);
    if (this.levelMode(policy, level) === ApprovalMode.Sequential) return slotCount;
    const configured = spec?.min_approvals ?? policy.min_approvals ?? 1;
    return Math.max(1, Math.min(configured, slotCount));
  }

  /** Has a single level been satisfied (enough approvals for its mode + quorum)? */
  private levelSatisfied(
    policy: ApprovalShape.PolicyRow,
    level: number,
    levelSlots: ApprovalShape.RecordApproverRow[],
  ): boolean {
    const approved = levelSlots.filter((r) => r.status === RecordApproverStatus.Approved).length;
    return approved >= this.levelQuorum(policy, level, levelSlots.length);
  }

  /** Distinct level numbers present in a chain, ascending. */
  private levelsOf(chain: ApprovalShape.RecordApproverRow[]): number[] {
    return [...new Set(chain.map((r) => r.level))].sort((a, b) => a - b);
  }

  /** Is the WHOLE chain satisfied (every level cleared per its own mode + quorum)? */
  private chainSatisfied(
    policy: ApprovalShape.PolicyRow,
    chain: ApprovalShape.RecordApproverRow[],
  ): boolean {
    return this.levelsOf(chain).every((lvl) =>
      this.levelSatisfied(policy, lvl, chain.filter((r) => r.level === lvl)),
    );
  }

  /**
   * Has the chain completed (positively) after this approving vote? Advances level-by-level: the
   * decided level must be satisfied per its own mode + quorum (W3-08 / W3-04); if a higher level
   * remains, its approvers are notified and the chain stays open; if the decided level was the last,
   * the chain is complete.
   */
  private async evaluateCompletion(
    policy: ApprovalShape.PolicyRow,
    recordType: string,
    recordId: string,
    decidedSlot: ApprovalShape.RecordApproverRow,
    t: Transaction,
  ): Promise<boolean> {
    const chain = await this.chain.listForRecord(recordType, recordId, t);
    const currentLevel = decidedSlot.level;
    const levelSlots = chain.filter((r) => r.level === currentLevel);

    if (!this.levelSatisfied(policy, currentLevel, levelSlots)) return false;

    const higherLevels = this.levelsOf(chain).filter((lvl) => lvl > currentLevel);
    if (higherLevels.length > 0) {
      // The satisfied level's remaining members can no longer act — skip their pending slots.
      await this.chain.skipRemainingAtLevel(recordType, recordId, currentLevel, t);
      // Advance: notify the NEXT level's pending approvers.
      const nextLevel = higherLevels[0];
      for (const slot of chain.filter(
        (r) => r.level === nextLevel && r.status === RecordApproverStatus.Pending,
      )) {
        await this.stageApprovalRequested(slot, decidedSlot.approver_id, t);
      }
      return false;
    }
    return true;
  }

  /** Stage an `ApprovalRequested` event for one approver slot (notification-bound). */
  private async stageApprovalRequested(
    slot: ApprovalShape.RecordApproverRow,
    requestedBy: string,
    t: Transaction,
  ): Promise<void> {
    // Resolved slots carry a concrete approver id we can address; group/manager slots are already
    // expanded to concrete users by the resolver before reaching this point.
    const recipientUserId = slot.approver_id;
    const payload: PayloadOf<EventTopic.ApprovalRequested> = {
      approvalId: randomUUID(),
      subjectType: slot.record_type,
      subjectId: slot.record_id,
      requestedBy,
      recordType: slot.record_type,
      recordId: slot.record_id,
      level: slot.level,
      recipientUserId,
    };
    await stageOutboxEvent(makeEnvelope(EventTopic.ApprovalRequested, payload), t);
  }

  /** Stage an `ApprovalCompleted` event so the owning service advances its record. */
  private async emitCompleted(
    recordType: string,
    recordId: string,
    outcome: ApprovalShape.ChainOutcome,
    decidedBy: string,
    t: Transaction,
  ): Promise<void> {
    const payload: PayloadOf<EventTopic.ApprovalCompleted> = {
      approvalId: randomUUID(),
      subjectType: recordType,
      subjectId: recordId,
      outcome,
      recordType,
      recordId,
      decidedBy,
    };
    await stageOutboxEvent(makeEnvelope(EventTopic.ApprovalCompleted, payload), t);
  }

  /** Assemble a `DecisionResult` from the current live chain. */
  private async decisionResult(
    recordType: string,
    recordId: string,
    completed: boolean,
    outcome: ApprovalShape.ChainOutcome | undefined,
    t: Transaction,
  ): Promise<ApprovalShape.DecisionResult> {
    const chain = await this.chain.listForRecord(recordType, recordId, t);
    return { recordType, recordId, completed, outcome, chain };
  }
}
