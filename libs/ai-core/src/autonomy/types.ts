/**
 * @aegis/ai-core / autonomy — TYPES for the FIRST autonomous capability (the self-audit), built to the
 * doctrine "the agent reasons; the governed core acts" and hardened by the verifiability layer
 * (docs/strategy/agentic-operations.md §0, §6.1).
 *
 * This capability is PROPOSE-ONLY. It READS + REASONS + emits PROPOSALS for a human. It NEVER writes,
 * never moves money, never touches a tool-execution path. Autonomous MATERIAL writes remain FORBIDDEN;
 * the whole point is to surface *verified proposals*, not to act. These types carry no write-capable
 * shapes — there is deliberately no "execute", "commit", or "apply" surface anywhere in this module.
 */

import type { Blast, VerificationVerdict } from '../verification/types';

/**
 * A raw discrepancy surfaced by a deterministic audit check, BEFORE it has been through the Trust Rule.
 * A finding is inherently a DISCREPANCY: what the ground truth says should be (`expected`) versus what
 * was actually observed (`observed`). It is a candidate for human attention, never an instruction to act.
 */
export interface RawFinding {
  /** A stable reference to the audited subject (e.g. an invoice id, a config key, a ledger row). */
  subjectRef: string;
  /** Human-readable one-line summary of the discrepancy. */
  summary: string;
  /** The ground-truth value the vetted recompute says should hold. */
  expected: unknown;
  /** The value actually observed in the system (differs from `expected` for a genuine finding). */
  observed: unknown;
  /** A human-readable recommendation for the reviewer — advisory ONLY; never auto-applied. */
  recommendation: string;
}

/**
 * A single audit check.
 *
 * `run` is a DETERMINISTIC recompute SELECTED from a vetted, version-pinned library of reconciliation
 * queries — the LLM never AUTHORS it (mirrors the trust-rule doctrine: determinism proves REPRODUCIBILITY,
 * not truth, and the recompute query must be human-vetted, §0, §6.1 #2). The capability RUNS whatever
 * checks it is handed; enforcing "selected, not authored" is the caller's responsibility.
 */
export interface AuditCheck {
  /** Stable identifier for this check (used as the `ranByCheck` key and on emitted proposals). */
  id: string;
  /** Human-readable description of what this check reconciles. */
  description: string;
  /** The blast radius of the write this finding would *propose* — decides V1-only vs the hardened AND. */
  blast: Blast;
  /**
   * The DETERMINISTIC recompute. Selected from a vetted, version-pinned library; NEVER LLM-authored.
   * Returns the discrepancies it found.
   */
  run(): Promise<{ findings: RawFinding[] }>;
}

/**
 * The disposition of a proposal after the Trust Rule has judged it.
 *   verified_proposal — the finding was independently verified to the tier its blast requires; a human
 *                       may act on it with confidence. (Still PROPOSE-ONLY — nothing is auto-executed.)
 *   needs_human       — the finding could not be verified to its required tier; a human must adjudicate.
 */
export type AuditProposalStatus = 'verified_proposal' | 'needs_human';

/** One proposal: a finding plus the verdict the hardened Trust Rule returned for it. Pure DATA. */
export interface AuditProposal {
  /** The id of the check that produced the underlying finding. */
  checkId: string;
  /** The raw discrepancy this proposal is about. */
  finding: RawFinding;
  /** The blast radius carried through from the check (drives the tier the Trust Rule enforced). */
  blast: Blast;
  /** The aggregate verdict from `assertTrustForAutonomousWrite` (methods actually satisfied, reasons). */
  verdict: VerificationVerdict;
  /** Disposition derived from `verdict.verified`. */
  status: AuditProposalStatus;
}

/** The aggregate result of one self-audit run. Pure DATA — a report for a human, not an action log. */
export interface SelfAuditReport {
  /** Every proposal produced this run (verified or needs-human), in check-then-finding order. */
  proposals: AuditProposal[];
  /** Roll-up counts. */
  counts: {
    total: number;
    verified: number;
    needsHuman: number;
  };
  /** Number of findings each check produced, keyed by check id. */
  ranByCheck: Record<string, number>;
}

/**
 * The ONLY external effect this capability has: hand each finished proposal to a sink (a queue, a
 * review inbox, a ledger append). The sink receives DATA; the capability itself never executes anything.
 */
export type ProposalSink = (p: AuditProposal) => void | Promise<void>;
