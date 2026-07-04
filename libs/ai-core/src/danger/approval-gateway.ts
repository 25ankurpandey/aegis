import type { DangerDecision } from './types';

/**
 * @aegis/ai-core / danger — the APPROVAL GATEWAY seam (docs/strategy §3.2 R5, §3.3).
 *
 * When a `DangerDecision` requires a human (second_approver / block), the gate cannot itself talk to
 * the approvals engine — @aegis/ai-core is deliberately dependency-light and must NOT import
 * @aegis/approvals (that would couple the AI substrate to a heavy backend package). Instead an APP
 * wires an implementation of `ApprovalGateway` that adapts to `@aegis/approvals`' maker-checker engine
 * (a danger-originated request with `origin: 'danger'`, the verdict attached, SoD merged with any
 * tier-level policy — "one approvals engine", never a parallel system).
 *
 * This file is INTERFACE + TYPES ONLY — the seam, no implementation.
 */

/** A request to open a human gate for a danger-escalated action. */
export interface ApprovalRequest {
  /** The originating principal (the human, or the OBO originating `sub` for an agent). */
  requesterPrincipal: string;
  tenantId: string;
  /** Stable id for the concrete, validated action being gated (echoed on the approval card). */
  actionRef: string;
  /** The danger decision that triggered this gate — carried onto the approval card and the ledger. */
  decision: DangerDecision;
  /**
   * Server-derived, human-readable facts for the card (the anti-deictic discipline: the approver
   * approves the VALIDATED action, never the model's paraphrase).
   */
  factsSummary: string;
  /**
   * True when this is the single-human degrade path (out-of-band confirmation + platform review
   * queue) rather than an in-tenant second approver — the implementation routes accordingly and must
   * NEVER satisfy the gate by self-approval.
   */
  outOfBand?: boolean;
  correlationId?: string;
}

export type ApprovalStatus = 'pending' | 'granted' | 'denied';

export interface ApprovalHandle {
  approvalId: string;
  status: ApprovalStatus;
}

/**
 * The seam an app implements over `@aegis/approvals`. `requireApproval` opens the gate and returns a
 * handle; it MUST enforce SoD (approver ≠ requester) and, for `outOfBand` requests, MUST use a
 * second-channel confirmation + platform review queue rather than any self-approval.
 */
export interface ApprovalGateway {
  requireApproval(req: ApprovalRequest): Promise<ApprovalHandle>;
}
