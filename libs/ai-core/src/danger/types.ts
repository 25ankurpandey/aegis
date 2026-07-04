/**
 * @aegis/ai-core / danger — TYPES for the DANGER layer, the SECOND control axis.
 *
 * Two ORTHOGONAL axes gate every mutation (docs/strategy/agentic-operations.md §3, §0, §6):
 *
 *   AUTHORIZATION (the PEP / Casbin) — "is this principal ALLOWED to do this?"
 *   DANGER (this layer)             — "they are allowed, but is THIS specific invocation risky
 *                                       enough that we should make them prove they mean it?"
 *
 * Danger fires AFTER a PEP allow and BEFORE the mutation. It NEVER grants anything (a PEP deny is
 * final and this layer cannot override it); it can only ADD friction, delay, witnesses, or a
 * block-pending-review on top of an allow. Danger can only ever TIGHTEN — never loosen — the gate.
 *
 * The classifier is DETERMINISTIC (§3.1): the LLM never computes a danger level, never sees
 * thresholds as mutable input, and cannot talk the classifier down (symmetric with the anti-deictic
 * rule). The anomaly signal is ADVISORY — it may only RAISE the level as an additional trigger, never
 * be the sole basis for a hard response, and never lower it (§3.1, §6.3).
 */

/** How the action mutates (or reads) state. Drives the destructiveness dimension. */
export type VerbClass = 'read' | 'create' | 'update' | 'delete' | 'execute';

/** How sensitive the touched data is. Drives the sensitivity dimension. */
export type DataSensitivity = 'none' | 'pii' | 'financial' | 'secret';

/**
 * The tool's static risk tier (blast-radius classification of the TOOL, not the invocation).
 * 1 = read · 2 = reversible write · 3 = external/notify · 4 = money/irreversible. Danger composes
 * with this (§3.3) by taking the most-restrictive requirement of each axis.
 */
export type RiskTier = 1 | 2 | 3 | 4;

/**
 * An advisory anomaly score for the request against the principal's / cohort's baseline. ADVISORY
 * ONLY: it can bump the level by at most +1 and can never be the sole gate for a hard response
 * (§3.1). `score` is normalized 0..1.
 */
export interface AnomalySignal {
  score: number;
  reason?: string;
}

/**
 * The DETERMINISTIC facts the classifier scores — every field is computed server-side from validated
 * inputs, NEVER taken from client or model output. `count` is the pre-flight COUNT(*) run inside the
 * same RLS tx with the exact filter that will execute (the linchpin for blast radius). `amountMinor`
 * is money in minor units (cents) to avoid float drift.
 */
export interface DangerFacts {
  verbClass: VerbClass;
  /** e.g. 'invoice', 'payment', 'user_role', 'audit_config', 'customer_export'. */
  resourceClass: string;
  /** Pre-flight COUNT(*) of rows the action will affect (blast radius). Absent ⇒ treated as 1. */
  count?: number;
  /** Monetary value in MINOR units (e.g. cents). Absent ⇒ non-monetary. */
  amountMinor?: number;
  /** Sensitivity of the touched/exported data. Absent ⇒ 'none'. */
  dataSensitivity?: DataSensitivity;
  /**
   * True iff the action touches the regulatory registry (audit config, retention policy, permissions,
   * compliance rules, ledger export). The layer protects its own configuration (§3.1 dim 5).
   */
  regulatory?: boolean;
  /** True iff the action cannot be undone (hardens destructiveness + forces a human for money). */
  irreversible?: boolean;
  /** The tool's static risk tier, for composition (§3.3). */
  riskTier?: RiskTier;
  /** Advisory anomaly signal — RAISES only, never the sole gate, never lowers (§3.1). */
  anomaly?: AnomalySignal;
}

/**
 * The overall danger level. 0 benign · 1 notable · 2 dangerous · 3 high · 4 critical · 5 reserved for
 * the hardest floor rules (regulatory audit/retention destruction). Computed as the MAX of the
 * deterministic dimensions, then bumped by at most the (capped) anomaly signal.
 */
export type DangerLevel = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * The friction imposed on top of an allow. Ordered loosest→tightest for composition — danger may only
 * move UP this ladder, never down.
 *
 *   allow          — R0: execute + log, no friction.
 *   confirm        — R1: one-click inline confirm of server-computed facts.
 *   typed_confirm  — R2: user types the server-generated phrase encoding the blast radius.
 *   step_up        — R3: fresh action-bound WebAuthn/passkey re-auth (no session reuse).
 *   cooling_off    — R4: staged execution after a delay, with one-click UNDO for watchers.
 *   second_approver— R5: routed through @aegis/approvals with approver ≠ requester (SoD).
 *   alert_only     — R6: notify owner/admin/security; non-blocking side effect.
 *   block          — R7: soft-block pending security review; terminal unless released.
 */
export type Ceremony =
  | 'allow'
  | 'confirm'
  | 'typed_confirm'
  | 'step_up'
  | 'cooling_off'
  | 'second_approver'
  | 'alert_only'
  | 'block';

/**
 * The deterministic classification result. `dimensions` records the per-dimension score so the ledger
 * can explain WHY a challenge fired (auditability); `reasons` are human-readable rule hits.
 */
export interface DangerAssessment {
  level: DangerLevel;
  /** Per-dimension scores: destructiveness, blastRadius, monetary, sensitivity, regulatory, anomaly. */
  dimensions: Record<string, number>;
  reasons: string[];
}

/**
 * The final gate decision. Composes the deterministic level with tier/floor escalations. `ceremony`
 * is the PRIMARY (tightest) friction; danger responses stack, so extra requirements are surfaced as
 * flags (requiresHuman, coolingOffMs, alertRoles, typedConfirmationPhrase).
 *
 * SINGLE-HUMAN tenants (§0, §6.3, §6.7): when a second approver is required but the approver pool has
 * ≤ 1 human, we NEVER collapse into silent self-approval. Instead `requiresOutOfBand` + `reviewQueue`
 * are set: mandatory out-of-band (email/SMS) second-channel confirmation PLUS a platform-side
 * security-review queue as the substitute checker.
 */
export interface DangerDecision {
  ceremony: Ceremony;
  level: DangerLevel;
  assessment: DangerAssessment;
  /** True iff a human (approver or reviewer) must act before execution. */
  requiresHuman: boolean;
  /** The server-generated typed phrase for destructive/irreversible bulk, e.g. "DELETE 4211 invoice". */
  typedConfirmationPhrase?: string;
  /** Cooling-off delay in ms before staged execution, if R4 applies. */
  coolingOffMs?: number;
  /** Roles to alert (R6), e.g. ['admin'], ['owner','security']. */
  alertRoles?: string[];
  /** SINGLE-HUMAN degrade: require out-of-band second-channel confirmation instead of self-approval. */
  requiresOutOfBand?: boolean;
  /** SINGLE-HUMAN degrade: flag for the platform-side security-review queue (substitute checker). */
  reviewQueue?: boolean;
  reasons: string[];
}
