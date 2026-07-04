import { randomUUID } from 'node:crypto';
import type { AegisTool } from '../tool-registry/types';
import { invokeTool, type InvokeContext, type InvokeResult } from '../tool-server/tool-server';
import { deriveDangerFacts } from '../orchestrator/derive-danger-facts';
import { evaluateActionGate, type DangerGateContext } from '../danger/danger-gate';
import type { DangerDecision } from '../danger/types';
import type { ApprovalGateway, ApprovalHandle } from '../danger/approval-gateway';
import {
  executeSupervisedWrite,
  type CeremonyEvidence,
  type SupervisedWriteParams,
  type SupervisedWriteResult,
} from './supervised-write';

/**
 * @aegis/ai-core / execution — THE SUPERVISED ACTION BROKER (the running two-step flow over D19).
 *
 * {@link executeSupervisedWrite} is the fail-closed supervised-write path, but it is a single function
 * call: it presumes the caller already holds the {@link DangerDecision} AND the {@link CeremonyEvidence}
 * proving the human ceremony was completed. In a real product those two facts are separated in TIME — the
 * gate is computed and the required ceremony surfaced on one request; the human completes it and the
 * action executes on a LATER request. This broker is the running flow that bridges that gap:
 *
 *   propose — compute the danger decision for a concrete tool + args. If the gate says `allow` (R0), run
 *             it straight through the governed route and return the result. Otherwise PERSIST the pending
 *             action (so it survives between requests) and return the ceremony the human must complete —
 *             WITHOUT invoking anything. For a `second_approver` gate it opens the approval handle too.
 *   confirm — load the persisted pending action and hand it to {@link executeSupervisedWrite} with the
 *             evidence the human produced. The action runs over the guarded route ONLY when the ceremony
 *             AND the (material-write) verifier pass; on success the pending action is deleted so it can
 *             never be replayed. Fail-closed: no evidence / bad evidence / failed verifier ⇒ not executed,
 *             pending retained; an unknown/expired id ⇒ a clear refusal.
 *
 * Nothing here weakens the governed core: propose/confirm decide only whether we are permitted to REACH
 * the guarded route; the route still authenticates → authorizes(PEP) → validates → RLS → audits exactly
 * as for a human. The agent reasons; the governed core acts.
 */

/** A danger-gated action awaiting its human ceremony, persisted between `propose` and `confirm`. */
export interface PendingAction {
  id: string;
  tool: AegisTool;
  args: Record<string, unknown>;
  invoke: InvokeContext;
  decision: DangerDecision;
  createdAt: number;
}

/**
 * Persistence seam for pending actions. In-process by default ({@link InMemoryPendingActionStore}); a
 * real deployment backs this with a shared store (the pending action must outlive a single node). Every
 * method may be sync or async so an implementation can be a Map or a network call.
 */
export interface PendingActionStore {
  put(action: PendingAction): void | Promise<void>;
  get(id: string): PendingAction | undefined | Promise<PendingAction | undefined>;
  delete(id: string): void | Promise<void>;
}

/** In-memory {@link PendingActionStore} (a Map) — deterministic + dependency-free, for tests/single-node. */
export class InMemoryPendingActionStore implements PendingActionStore {
  private readonly actions = new Map<string, PendingAction>();

  put(action: PendingAction): void {
    this.actions.set(action.id, action);
  }

  get(id: string): PendingAction | undefined {
    return this.actions.get(id);
  }

  delete(id: string): void {
    this.actions.delete(id);
  }
}

/** Wiring for a {@link SupervisedActionBroker}. */
export interface SupervisedActionBrokerOptions {
  store: PendingActionStore;
  /** Optional approvals seam — opened when a decision requires a `second_approver`. */
  approvals?: ApprovalGateway;
  /** Injectable id generator for pending actions (defaults to a uuid) — lets tests assert stable ids. */
  idFactory?: () => string;
}

/** Result of {@link SupervisedActionBroker.propose}: either ran straight through, or awaits a ceremony. */
export type ProposeResult =
  | { status: 'allow'; result: InvokeResult }
  | {
      status: 'needs_ceremony';
      pendingId: string;
      decision: DangerDecision;
      /** Present when the decision required a `second_approver` and an approvals gateway was wired. */
      approval?: ApprovalHandle;
    };

/** Input to {@link SupervisedActionBroker.propose}. */
export interface ProposeParams {
  tool: AegisTool;
  args: Record<string, unknown>;
  invoke: InvokeContext;
  /** Context for the danger gate (approver pool size, classifier overrides, …). */
  gateContext: DangerGateContext;
}

/** Input to {@link SupervisedActionBroker.confirm}. */
export interface ConfirmParams {
  pendingId: string;
  /** Proof the human completed the required ceremony. */
  evidence: CeremonyEvidence;
  /** Verification wiring forwarded to the supervised-write path (V1/V2 for material writes). */
  verify?: SupervisedWriteParams['verify'];
}

/**
 * The running two-step supervised-write flow. Construct with a {@link PendingActionStore} (and optionally
 * an {@link ApprovalGateway}); call {@link propose} to gate an action and {@link confirm} to execute it
 * once its ceremony is satisfied.
 */
export class SupervisedActionBroker {
  private readonly store: PendingActionStore;
  private readonly approvals?: ApprovalGateway;
  private readonly idFactory: () => string;

  constructor(options: SupervisedActionBrokerOptions) {
    this.store = options.store;
    this.approvals = options.approvals;
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  /**
   * Compute the danger decision for `tool` + `args`. An `allow` decision runs straight through the
   * governed route and returns the result. Any other ceremony persists the pending action and returns
   * the decision the human must satisfy — no HTTP invoke happens on this path.
   */
  async propose(params: ProposeParams): Promise<ProposeResult> {
    const { tool, args, invoke, gateContext } = params;
    const decision = evaluateActionGate(deriveDangerFacts(tool, args), gateContext);

    if (decision.ceremony === 'allow') {
      const result = await invokeTool(tool, args, invoke);
      return { status: 'allow', result };
    }

    const id = this.idFactory();
    const pending: PendingAction = { id, tool, args, invoke, decision, createdAt: Date.now() };
    await this.store.put(pending);

    let approval: ApprovalHandle | undefined;
    if (this.approvals && decision.ceremony === 'second_approver') {
      approval = await this.approvals.requireApproval({
        requesterPrincipal: invoke.token,
        tenantId: invoke.tenantId,
        actionRef: id,
        decision,
        factsSummary: `${tool.name} ${JSON.stringify(args)}`,
        outOfBand: decision.requiresOutOfBand,
        correlationId: invoke.correlationId,
      });
    }

    return { status: 'needs_ceremony', pendingId: id, decision, ...(approval ? { approval } : {}) };
  }

  /**
   * Execute a previously-proposed action once its ceremony is satisfied. Loads the pending action (a
   * missing/expired id is refused, fail-closed), runs it through {@link executeSupervisedWrite} with the
   * human's evidence, and — only when it actually executed — deletes the pending action so it cannot be
   * replayed. A refused write leaves the pending action in place for a later, valid confirm.
   */
  async confirm(params: ConfirmParams): Promise<SupervisedWriteResult> {
    const { pendingId, evidence, verify } = params;
    const pending = await this.store.get(pendingId);
    if (!pending) {
      return { executed: false, refusedReason: `no pending action for id "${pendingId}" (unknown or expired)` };
    }

    const res = await executeSupervisedWrite({
      tool: pending.tool,
      args: pending.args,
      invoke: pending.invoke,
      decision: pending.decision,
      evidence,
      verify,
    });

    if (res.executed) {
      await this.store.delete(pendingId);
    }
    return res;
  }
}
