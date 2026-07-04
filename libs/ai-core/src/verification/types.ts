/**
 * @aegis/ai-core / verification — TYPES for the VERIFIABILITY layer (the "can I trust the result?"
 * half of §1), hardened per docs/strategy/agentic-operations.md §0 and §6.1.
 *
 * The verifiability layer answers a different question from AUTHORIZATION ("are you allowed?") and
 * DANGER ("is this risky even if allowed?"): it asks whether the RESULT an autonomous write is about
 * to commit is trustworthy enough to commit at all. An autonomous result is only sellable if it is
 * PROVABLY correct or PROVABLY checked — that binding is the Trust Rule (see ./trust-rule.ts).
 *
 * Two red-team corrections from §0 are baked into these types:
 *   - determinism != correctness — a deterministic recompute (V1) proves REPRODUCIBILITY, not truth,
 *     so for material writes it must be PAIRED with an independent judgment (V2), never trusted alone.
 *   - identity-SoD != independence — a "different principal" on the SAME model has the same blind
 *     spots (correlated failure is the default), so V2 mandates a DIFFERENT model family.
 */

/**
 * The three verification methods the layer can apply to a claim.
 *   deterministic — V1: recompute the claimed value and byte-compare it against the expectation. Proves
 *                   the number is REPRODUCIBLE, not that it is CORRECT (§6.1 #2).
 *   dual_control  — V2: an independent verifier (mandated different model family) judges the claim on
 *                   its own — the check against correlated single-model failure (§6.1 #1).
 *   sampled       — a sampled LLM-judge: bounds the rate at which errors are DISCOVERED, not the rate
 *                   at which they OCCUR. FORBIDDEN as the sole method for material writes (§6.1 #3,#4).
 */
export type VerificationMethod = 'deterministic' | 'dual_control' | 'sampled';

/**
 * The blast radius of the write whose result is being verified. Ordered least→most consequential.
 *   read         — no state change; a single method (or none) suffices.
 *   reversible    — a cheaply-undoable write; a single method suffices.
 *   external      — leaves the system (notify/email/webhook); MATERIAL — requires the hardened AND.
 *   money         — moves money; MATERIAL — requires the hardened AND.
 *   irreversible  — cannot be undone; MATERIAL — requires the hardened AND.
 */
export type Blast = 'read' | 'reversible' | 'external' | 'money' | 'irreversible';

/** Blasts for which §0's hardened Trust Rule mandates BOTH V1 (deterministic) AND V2 (independent). */
export const MATERIAL_BLASTS: readonly Blast[] = ['money', 'external', 'irreversible'];

/** True iff `blast` is a material write (money/external/irreversible) subject to the hardened AND. */
export function isMaterialBlast(blast: Blast): boolean {
  return MATERIAL_BLASTS.includes(blast);
}

/**
 * A request to verify one claim produced by an autonomous write path, before it commits.
 *
 * `deterministicRecheck` is the V1 recompute: it must be selected from a human-reviewed, version-pinned
 * library of vetted reconciliation queries — the LLM SELECTS it, never AUTHORS it (§0). This layer runs
 * whatever thunk it is given; enforcing "selected, not authored" is the caller's responsibility. The
 * recompute returns `{ value }`, which is deep-compared against `expected`.
 */
export interface VerificationRequest {
  /** The blast radius of the write — decides whether one method suffices or the hardened AND is required. */
  blast: Blast;
  /** The claim under verification, in human-readable form (also shown to the independent verifier). */
  claim: string;
  /** Optional evidence the maker relied on. NOTE (§6.1 #7): the independent verifier should read its OWN
   *  fresh snapshot, not this bundle — evidence drift means the maker's bundle may be stale. */
  evidence?: unknown;
  /** V1: the vetted, version-pinned recompute. Its `value` must deep-equal `expected` to satisfy V1. */
  deterministicRecheck?: () => Promise<{ value: unknown }>;
  /** The expected value V1 must reproduce (deep-equal). */
  expected?: unknown;
}

/**
 * The aggregate verdict. `verified` is the gate; `methods` lists ONLY the methods that were actually
 * SATISFIED (so the runtime invariant can assert the SPECIFIC method set a tier requires, not merely
 * "the rule was satisfied" — §0); `reasons` explain every pass/fail for the ledger. `confidence` is
 * advisory only and is deliberately NOT load-bearing (§6.1 #5: LLM confidence is miscalibrated).
 */
export interface VerificationVerdict {
  verified: boolean;
  methods: VerificationMethod[];
  reasons: string[];
  confidence?: number;
}

/** Construction config for a {@link IndependentVerifier} built on an injected LLM (see ./verifier.ts). */
export interface VerifierConfig {
  /** The model id / family of the PROPOSER (maker) that produced the claim. */
  proposerModelId: string;
  /** The model id / family of the VERIFIER. Must DIFFER from the proposer or independence fails (§0). */
  verifierModelId: string;
}
