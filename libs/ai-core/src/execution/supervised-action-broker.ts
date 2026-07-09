import { randomUUID } from 'node:crypto';
import type { AegisTool } from '../tool-registry/types';
import { invokeTool, type InvokeContext, type InvokeResult } from '../tool-server/tool-server';
import { deriveDangerFacts } from '../orchestrator/derive-danger-facts';
import { evaluateActionGate, type DangerGateContext } from '../danger/danger-gate';
import { isCeremonyStricter } from '../danger/danger-policy';
import type { DangerDecision, DangerFacts } from '../danger/types';
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

/** Identity of the principal on one side of the propose/confirm flow (AGENT-01 binding). */
export interface PrincipalRef {
  /** The acting user's id. Undefined only for a principal-less/system caller (then self-confirm is refused). */
  userId?: string;
  /** The tenant the action belongs to — the confirmer MUST match it (cross-tenant confirm is refused). */
  tenantId: string;
}

/** A danger-gated action awaiting its human ceremony, persisted between `propose` and `confirm`. */
export interface PendingAction {
  /** Internal, tenant-namespaced storage key (`${tenantId}::${uuid}`) — NOT the client-facing id. */
  id: string;
  /** Who proposed this action — the confirm side is checked against it (AGENT-01). */
  proposer: PrincipalRef;
  tool: AegisTool;
  args: Record<string, unknown>;
  invoke: InvokeContext;
  decision: DangerDecision;
  /** The gate context used at propose, stored so `confirm` can RE-EVALUATE the gate (AGENT-05). */
  gateContext: DangerGateContext;
  createdAt: number;
}

/** Namespace a pending-action storage key by tenant (AGENT-06) so a cross-tenant lookup can never hit it. */
function pendingStoreKey(tenantId: string, publicId: string): string {
  return `${tenantId}::${publicId}`;
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
  /** WHO is proposing — bound to the pending action so only a legitimate party can confirm it (AGENT-01). */
  proposer: PrincipalRef;
}

/** Input to {@link SupervisedActionBroker.confirm}. */
export interface ConfirmParams {
  pendingId: string;
  /** Proof the human completed the required ceremony. */
  evidence: CeremonyEvidence;
  /** WHO is confirming — checked against the stored proposer (AGENT-01): same tenant always; same user
   *  for self-satisfiable ceremonies; a DIFFERENT same-tenant user for `second_approver` (SoD). */
  confirmer: PrincipalRef;
  /** Verification wiring forwarded to the supervised-write path (V1/V2 for material writes). */
  verify?: SupervisedWriteParams['verify'];
  /** Optional facts re-derived against the LIVE state (e.g. an authoritative row COUNT) — lets the app
   *  close the TOCTOU (AGENT-05). When omitted, facts are re-derived from the (frozen) args. */
  liveFacts?: DangerFacts;
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
    const { tool, args, invoke, gateContext, proposer } = params;
    const decision = evaluateActionGate(deriveDangerFacts(tool, args), gateContext);

    if (decision.ceremony === 'allow') {
      const result = await invokeTool(tool, args, invoke);
      return { status: 'allow', result };
    }

    // The client-facing id is an opaque uuid; the STORAGE key is namespaced by the proposer's tenant
    // (AGENT-06) so a confirm from another tenant computes a different key and can never find it.
    const publicId = this.idFactory();
    const storeKey = pendingStoreKey(proposer.tenantId, publicId);
    const pending: PendingAction = {
      id: storeKey,
      proposer,
      tool,
      args,
      invoke,
      decision,
      gateContext,
      createdAt: Date.now(),
    };
    await this.store.put(pending);

    let approval: ApprovalHandle | undefined;
    if (this.approvals && decision.ceremony === 'second_approver') {
      approval = await this.approvals.requireApproval({
        requesterPrincipal: invoke.token,
        tenantId: invoke.tenantId,
        actionRef: publicId,
        decision,
        factsSummary: `${tool.name} ${JSON.stringify(args)}`,
        outOfBand: decision.requiresOutOfBand,
        correlationId: invoke.correlationId,
      });
    }

    return { status: 'needs_ceremony', pendingId: publicId, decision, ...(approval ? { approval } : {}) };
  }

  /**
   * Execute a previously-proposed action once its ceremony is satisfied. Loads the pending action (a
   * missing/expired id is refused, fail-closed), runs it through {@link executeSupervisedWrite} with the
   * human's evidence, and — only when it actually executed — deletes the pending action so it cannot be
   * replayed. A refused write leaves the pending action in place for a later, valid confirm.
   */
  async confirm(params: ConfirmParams): Promise<SupervisedWriteResult> {
    const { pendingId, evidence, verify, confirmer, liveFacts } = params;

    // Look the action up under the CONFIRMER's tenant namespace (AGENT-06): an action proposed in a
    // different tenant lives under a different key, so a cross-tenant confirm simply finds nothing.
    const storeKey = pendingStoreKey(confirmer.tenantId, pendingId);
    const pending = await this.store.get(storeKey);
    if (!pending) {
      return { executed: false, refusedReason: `no pending action for id "${pendingId}" (unknown, expired, or wrong tenant)` };
    }

    // AGENT-01 — proposer binding. Tenant is already enforced by the key; assert it defensively, then
    // check the user relationship the ceremony requires.
    if (pending.proposer.tenantId !== confirmer.tenantId) {
      return { executed: false, refusedReason: 'confirmer tenant does not match the proposer tenant' };
    }
    const sameUser = confirmer.userId != null && confirmer.userId === pending.proposer.userId;
    if (pending.decision.ceremony === 'second_approver') {
      // Separation of duties: a DIFFERENT same-tenant user must approve — never the proposer.
      if (sameUser) {
        return { executed: false, refusedReason: 'second_approver requires a different user than the proposer (separation of duties)' };
      }
    } else {
      // Self-satisfiable ceremonies (confirm / typed_confirm / step_up / cooling_off): only the
      // proposing user may complete their own challenge — a bystander cannot trigger it.
      if (!sameUser) {
        return { executed: false, refusedReason: 'only the proposing user may complete this ceremony' };
      }
    }

    // AGENT-05 — re-evaluate the gate at confirm time; NEVER execute under a decision weaker than a
    // fresh evaluation. `liveFacts` (app-supplied, e.g. an authoritative live COUNT) closes the TOCTOU;
    // absent it we re-derive from the frozen args, which still catches a danger-policy/context tightening.
    const facts = liveFacts ?? deriveDangerFacts(pending.tool, pending.args);
    const fresh = evaluateActionGate(facts, pending.gateContext);
    if (isCeremonyStricter(fresh.ceremony, pending.decision.ceremony)) {
      await this.store.delete(storeKey);
      return {
        executed: false,
        refusedReason: `danger gate tightened since propose (now "${fresh.ceremony}", was "${pending.decision.ceremony}") — re-propose required`,
      };
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
      await this.store.delete(storeKey);
    }
    return res;
  }
}
