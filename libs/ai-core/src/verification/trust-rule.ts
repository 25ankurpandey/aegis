/**
 * @aegis/ai-core / verification — the hardened TRUST RULE (docs/strategy/agentic-operations.md §0).
 *
 * This is the GATE an autonomous-write path must pass before it commits. It does NOT itself execute
 * anything — like the danger gate, it runs AFTER a PEP allow and returns a verdict; the calling
 * write path is responsible for honoring a `verified: false`.
 *
 * TWO CORRECTIONS FROM §0 ARE ENCODED HERE, AND THE DOC-COMMENTS RESTATE THEM ON PURPOSE:
 *
 *   1. determinism != correctness. A deterministic recompute (V1) proves the number is REPRODUCIBLE —
 *      an LLM-authored-but-wrong query re-runs to the same wrong number forever (§6.1 #2). Reproducibility
 *      is NOT truth, so for material writes V1 is PAIRED with an independent judgment (V2); it is never
 *      trusted alone.
 *
 *   2. identity-SoD != independence. A "different principal" on the SAME model has the same blind spots,
 *      so correlated failure is the default (§6.1 #1, §6.4 #1). V2 therefore mandates a DIFFERENT model
 *      family; {@link IndependentVerifier} (DualControlVerifier) enforces this and fails closed otherwise.
 *
 * THE RULE IS AN AND, NOT AN OR (§0, §6.1 #4). For a MATERIAL write (blast ∈ {money, external,
 * irreversible}) BOTH V1 (deterministic recompute matches expected) AND V2 (independent dual-control
 * pass on a different model) are REQUIRED. `sampled` alone is FORBIDDEN for material writes — sampling
 * bounds the rate at which errors are DISCOVERED, not the rate at which they OCCUR. For a reversible or
 * read blast, a single satisfied method suffices.
 */

import type { IndependentVerifier } from './verifier';
import {
  isMaterialBlast,
  type VerificationMethod,
  type VerificationRequest,
  type VerificationVerdict,
} from './types';

/** Structural deep-equality for the V1 recompute comparison (order-sensitive for arrays, key-agnostic
 *  for objects). Kept local + dependency-free to match the "no new deps" constraint. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;

  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Run V1 (the deterministic recompute) and report whether it reproduced `expected`. */
async function runDeterministic(
  req: VerificationRequest,
): Promise<{ satisfied: boolean; reason: string }> {
  if (!req.deterministicRecheck) {
    return { satisfied: false, reason: 'deterministic recheck not provided (V1 unavailable)' };
  }
  let recomputed: { value: unknown };
  try {
    recomputed = await req.deterministicRecheck();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { satisfied: false, reason: `deterministic recheck threw: ${msg}` };
  }
  if (deepEqual(recomputed.value, req.expected)) {
    return {
      satisfied: true,
      reason: 'deterministic recompute reproduced the expected value (proves reproducibility, not correctness)',
    };
  }
  return {
    satisfied: false,
    reason:
      `deterministic recompute did NOT match expected: recomputed=${JSON.stringify(recomputed.value)} ` +
      `expected=${JSON.stringify(req.expected)}`,
  };
}

/** Options for {@link assertTrustForAutonomousWrite}. */
export interface TrustRuleOptions {
  /** Run the deterministic V1 recompute. Required to be true for material writes. */
  deterministic?: boolean;
  /** The independent V2 verifier. Required (and must be different-model) for material writes. */
  independent?: IndependentVerifier;
  /** The proposer model id — passed through so the caller can wire independence at the verifier. */
  proposerModelId?: string;
}

/**
 * Assert the hardened Trust Rule for one autonomous write. Returns an aggregate verdict listing ONLY
 * the methods that were actually SATISFIED, so a runtime invariant can assert the SPECIFIC required
 * method set for the tier (§0), not merely "the rule was satisfied".
 *
 * MATERIAL writes (money/external/irreversible): require V1 AND V2. `sampled` alone is refused.
 * NON-material writes (reversible/read): a single satisfied method suffices.
 */
export async function assertTrustForAutonomousWrite(
  req: VerificationRequest,
  opts: TrustRuleOptions,
): Promise<VerificationVerdict> {
  const methods: VerificationMethod[] = [];
  const reasons: string[] = [];
  const material = isMaterialBlast(req.blast);

  // Evaluate V1 (deterministic recompute) if requested.
  let v1Satisfied = false;
  if (opts.deterministic) {
    const v1 = await runDeterministic(req);
    v1Satisfied = v1.satisfied;
    reasons.push(v1.reason);
    if (v1Satisfied) methods.push('deterministic');
  }

  // Evaluate V2 (independent dual-control) if a verifier was supplied.
  let v2Satisfied = false;
  if (opts.independent) {
    const v2 = await opts.independent.verify(req);
    v2Satisfied = v2.verified;
    reasons.push(...v2.reasons);
    if (v2Satisfied && v2.methods.includes('dual_control')) methods.push('dual_control');
  }

  if (material) {
    // THE HARDENED AND: both V1 and V2 are mandatory. `sampled` alone can never satisfy this — there is
    // no branch that admits it (§0, §6.1 #3,#4).
    if (!opts.deterministic) {
      reasons.unshift(
        `material blast "${req.blast}" requires a deterministic recompute (V1); none was requested — ` +
          'sampled-alone is forbidden for material writes',
      );
    }
    if (!opts.independent) {
      reasons.unshift(
        `material blast "${req.blast}" requires provably-independent dual-control (V2); no verifier was supplied`,
      );
    }
    const verified = v1Satisfied && v2Satisfied;
    if (verified) {
      reasons.unshift(
        `material blast "${req.blast}": hardened Trust Rule satisfied — V1 (deterministic) AND V2 (independent) both passed`,
      );
    } else {
      reasons.unshift(
        `material blast "${req.blast}": hardened Trust Rule NOT satisfied — requires BOTH V1 (deterministic recompute) ` +
          'AND V2 (independent dual-control on a different model)',
      );
    }
    return { verified, methods, reasons };
  }

  // NON-material (reversible / read): a single satisfied method suffices.
  const verified = v1Satisfied || v2Satisfied;
  if (verified) {
    reasons.unshift(
      `non-material blast "${req.blast}": a single verification method suffices and one was satisfied`,
    );
  } else {
    reasons.unshift(
      `non-material blast "${req.blast}": no verification method was satisfied`,
    );
  }
  return { verified, methods, reasons };
}
