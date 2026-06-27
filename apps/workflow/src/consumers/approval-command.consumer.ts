import { Logger, RequestContext } from '@aegis/service-core';
import { ApprovalDecision } from '@aegis/shared-enums';
import { ApprovalService } from '@aegis/approvals';
import {
  getBus,
  EventTopic,
  type EventEnvelope,
  type ApprovalCommandPayload,
} from '@aegis/events';
import { container } from '../ioc/container';

/**
 * ApprovalCommand consumer (BUG-0001). A workflow rule's `auto_approve` / `assign_approval_policy`
 * actions PRODUCE `EventTopic.ApprovalCommand` (apps/workflow/src/engine/actions/builtin.ts) but,
 * before this consumer, NOTHING subscribed to it — so the rule reported success while the command
 * silently no-op'd. This consumer (workflow WORKER role only) applies the command via the shared
 * `@aegis/approvals` `ApprovalService`, under the RequestContext the bus rebuilt from the envelope
 * (tenant + correlation id propagate, so RLS + audit attribution hold across the async hop).
 *
 * It uses ONLY existing `ApprovalService` methods (`requestApproval`, `getStatus`, `decide`) — the
 * lib is untouched. A failure propagates out of the handler so the bus's bounded retry → DLQ engages
 * (the engine's own guards make each step idempotent / re-runnable: a materialised chain is returned
 * unchanged on re-request, an already-decided slot conflicts rather than double-voting).
 */

/**
 * Synthetic principal recorded as the requester/decider for rule-driven approval commands. Not a real
 * user, so it can never collide with a configured approver slot (the SoD requester-exclusion is a
 * no-op for it) and the audit trail clearly attributes the action to the workflow engine + rule.
 */
const SYSTEM_PRINCIPAL = 'system:workflow';

/** Anti-ambient-authority guard: the rebuilt context tenant MUST match the envelope's own tenant. */
function assertEnvelopeTenant(env: EventEnvelope): void {
  const ctxTenant = RequestContext.tenantId(); // throws if no scope — fail-closed
  if (!env.tenantId || env.tenantId !== ctxTenant) {
    throw new Error('event tenant does not match propagated context tenant');
  }
}

/** Resolve the shared engine lazily so the DI container is fully loaded before first use. */
function approvals(): ApprovalService {
  return container.get(ApprovalService);
}

/**
 * Drive a record's live approval chain to APPROVED by casting an approving vote for every pending
 * approver, level by level, until the engine reports the chain completed. The engine advances the
 * chain on each `decide` (sequential level-by-level / parallel quorum), so we re-read the live chain
 * after each pass and stop as soon as it resolves. Bounded by the slot count to guarantee termination.
 */
async function driveToApproved(
  recordType: string,
  recordId: string,
  reason: string | undefined,
): Promise<void> {
  // Ensure a chain exists so there is something to decide. Idempotent: a live chain is returned
  // unchanged. An EMPTY resolved chain auto-completes as approved inside the engine — nothing to do.
  const requested = await approvals().requestApproval({
    recordType,
    recordId,
    requestedBy: SYSTEM_PRINCIPAL,
  });
  if (requested.chain.length === 0) return;

  // Cap iterations at the number of slots — each pass decides at least the active level's pending
  // approvers, so the chain cannot outlive its own slot count.
  const maxPasses = requested.chain.length + 1;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const status = await approvals().getStatus(recordType, recordId);
    if (status.completed) return;

    const pending = status.chain.filter((slot) => slot.status === 'pending');
    if (pending.length === 0) return;

    for (const slot of pending) {
      const result = await approvals().decide({
        recordType,
        recordId,
        approverId: slot.approver_id,
        decision: ApprovalDecision.Approved,
        comment: reason ?? 'workflow.auto_approve',
      });
      if (result.completed) return;
    }
  }
}

/**
 * Apply one ApprovalCommand. `autoApprove` drives the record's chain to approved; a `policyId` (the
 * `assign_approval_policy` action) binds the record into the approval flow by materialising its chain
 * under the tenant's active policy (idempotent — a re-bind returns the existing chain). When both are
 * present, the policy binding happens first (the chain is materialised) and then auto-approved.
 */
export async function applyApprovalCommand(
  env: EventEnvelope<ApprovalCommandPayload>,
): Promise<void> {
  assertEnvelopeTenant(env);
  const { recordType, recordId, autoApprove, policyId, reason, ruleId } = env.payload;
  if (!recordType || !recordId) {
    throw new Error('approval.command missing recordType/recordId');
  }

  if (policyId) {
    // Bind the record into the approval flow under the active policy. The engine resolves the policy
    // by (tenant, record_type); materialising the chain is the binding side effect. Idempotent.
    await approvals().requestApproval({ recordType, recordId, requestedBy: SYSTEM_PRINCIPAL });
    Logger.info('approval.command policy bound', { recordType, recordId, policyId, ruleId });
  }

  if (autoApprove) {
    await driveToApproved(recordType, recordId, reason);
    Logger.info('approval.command auto-approved', { recordType, recordId, ruleId });
  }
}

/**
 * Subscribe the ApprovalCommand consumer to the bus. Called from the workflow worker's
 * `registerConsumers()`. A failure propagates so the bus's retry + DLQ engage. This consumes a topic
 * workflow PRODUCES, but it runs the ENGINE (not the rules engine) — it never re-evaluates rules, so
 * there is no produce-then-consume rule loop.
 */
export function registerApprovalCommandConsumer(): void {
  const bus = getBus();
  bus.subscribe(EventTopic.ApprovalCommand, applyApprovalCommand);
  Logger.info('approval-command consumer registered', { topic: EventTopic.ApprovalCommand });
}
