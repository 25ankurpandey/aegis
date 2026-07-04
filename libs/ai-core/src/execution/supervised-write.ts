/**
 * @aegis/ai-core / execution — THE SUPERVISED-WRITE PATH (the D19 milestone).
 *
 * This module is the ONLY sanctioned way a dangerous / write action runs. It composes the platform's
 * THREE orthogonal controls into a single fail-closed gate that an autonomous write must pass, IN ORDER,
 * before {@link invokeTool} is ever called:
 *
 *   AUTHORIZATION — "is this principal allowed?" — already enforced at the route/PEP (Casbin) and
 *                   re-checked by the governed core when {@link invokeTool} hits the guarded HTTP route.
 *                   Nothing here weakens or substitutes for that PEP/RLS/audit chain; this path sits ON
 *                   TOP of it, never around it.
 *   DANGER        — "it is allowed, but is THIS invocation risky enough to demand human ceremony?" —
 *                   the danger gate (evaluateActionGate) computes a {@link DangerDecision}; we require
 *                   PROOF ({@link CeremonyEvidence}) that the required ceremony was actually completed.
 *   VERIFIABILITY — "is the RESULT trustworthy enough to commit?" — for MATERIAL writes
 *                   (money/external/irreversible) we require the hardened Trust Rule
 *                   (assertTrustForAutonomousWrite): V1 deterministic recompute AND V2 independent
 *                   dual-control on a DIFFERENT model family.
 *
 * MISSING ANY ONE OF THE THREE ⇒ REFUSED, and the tool is NEVER invoked. The composition is an AND, not
 * an OR: the ceremony proves a human meant it; the verifier proves the result is checkable; only when
 * both hold does the governed route run. This is fail-closed by construction — every early return leaves
 * `executed: false` and performs no HTTP call.
 */

import type { AegisTool } from '../tool-registry/types';
import { invokeTool, type InvokeContext, type InvokeResult } from '../tool-server/tool-server';
import { deriveDangerFacts } from '../orchestrator/derive-danger-facts';
import type { DangerDecision } from '../danger/types';
import type { DangerFacts } from '../danger/types';
import { assertTrustForAutonomousWrite } from '../verification/trust-rule';
import type { IndependentVerifier } from '../verification/verifier';
import type { Blast, VerificationVerdict } from '../verification/types';

/**
 * PROOF that the ceremony the danger gate demanded was actually completed. Each field is the evidence a
 * specific ceremony consumes; {@link ceremonySatisfied} enforces which fields are load-bearing for a
 * given {@link DangerDecision}. The evidence is supplied by the host (the human ceremony surface), never
 * fabricated by the agent — the agent cannot click, type, step-up, or approve on its own behalf.
 */
export interface CeremonyEvidence {
  /** The phrase the human typed for a `typed_confirm` ceremony (must EXACTLY equal the decision's phrase). */
  typedConfirmation?: string;
  /** The result of a fresh action-bound step-up (WebAuthn/passkey) assertion for a `step_up` ceremony. */
  stepUp?: { verified: boolean };
  /** The approval record for a `second_approver` ceremony; must be `granted` (SoD: approver ≠ requester). */
  approval?: { approvalId: string; status: 'pending' | 'granted' | 'denied' };
  /** Epoch-ms when the human confirmed — used by `confirm` (must be present) and `cooling_off` (must be aged). */
  confirmedAt?: number;
  /** Explicit one-click confirm flag, an alternative signal to `confirmedAt` for a `confirm` ceremony. */
  confirmed?: boolean;
  /**
   * True iff a mandatory out-of-band (email/SMS second-channel) confirmation was completed. Required
   * whenever `decision.requiresOutOfBand` is set (the SINGLE-HUMAN degrade: never silent self-approval).
   */
  outOfBandConfirmed?: boolean;
}

/** The result of checking ceremony evidence against a decision: `ok`, or `ok:false` with a `reason`. */
export interface CeremonyCheck {
  ok: boolean;
  reason?: string;
}

/**
 * DETERMINISTICALLY decide whether `evidence` satisfies the ceremony the danger gate demanded. This is
 * pure: the same decision + evidence always yields the same result (a hard requirement for a ledger a
 * regulator can replay). It ONLY reads evidence — it never invokes anything and never mints its own
 * approval. Fail-closed: an unknown ceremony and `block` both return not-ok.
 *
 * Per ceremony:
 *   allow           — ok (R0: execute + log, no friction).
 *   confirm         — requires `confirmedAt` (or an explicit `confirmed` flag): the human saw the facts.
 *   typed_confirm   — `typedConfirmation` must EXACTLY equal `decision.typedConfirmationPhrase`.
 *   step_up         — `stepUp.verified === true`: a fresh action-bound re-auth happened.
 *   cooling_off     — `confirmedAt` must be OLDER than `coolingOffMs` (the staged UNDO window elapsed).
 *   second_approver — `approval.status === "granted"` (approver ≠ requester, enforced upstream).
 *   alert_only      — ok, but the alert MUST have fired (a non-blocking side effect; see note below).
 *   block           — ALWAYS not-ok (terminal unless a security admin releases it out of band).
 *
 * If `decision.requiresOutOfBand` is set (SINGLE-HUMAN degrade), evidence MUST additionally carry
 * `outOfBandConfirmed === true` — otherwise not-ok, on top of the per-ceremony check.
 */
export function ceremonySatisfied(
  decision: DangerDecision,
  evidence: CeremonyEvidence,
): CeremonyCheck {
  // Out-of-band is an ADDITIONAL requirement layered on the per-ceremony check (SINGLE-HUMAN degrade):
  // a required second approver in a ≤1-human tenant must not collapse into silent self-approval.
  if (decision.requiresOutOfBand && evidence.outOfBandConfirmed !== true) {
    return {
      ok: false,
      reason:
        'out-of-band confirmation required (single-human degrade) but evidence.outOfBandConfirmed !== true',
    };
  }

  switch (decision.ceremony) {
    case 'allow':
      return { ok: true };

    case 'confirm':
      if (typeof evidence.confirmedAt === 'number' || evidence.confirmed === true) {
        return { ok: true };
      }
      return { ok: false, reason: 'confirm ceremony requires evidence.confirmedAt (or evidence.confirmed)' };

    case 'typed_confirm': {
      const expected = decision.typedConfirmationPhrase;
      if (typeof expected !== 'string' || expected.length === 0) {
        return {
          ok: false,
          reason: 'typed_confirm ceremony but decision carried no typedConfirmationPhrase to match',
        };
      }
      if (evidence.typedConfirmation === expected) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: `typed_confirm phrase mismatch: expected "${expected}", got "${evidence.typedConfirmation ?? ''}"`,
      };
    }

    case 'step_up':
      if (evidence.stepUp?.verified === true) {
        return { ok: true };
      }
      return { ok: false, reason: 'step_up ceremony requires evidence.stepUp.verified === true' };

    case 'cooling_off': {
      const holdMs = decision.coolingOffMs;
      if (typeof holdMs !== 'number' || holdMs <= 0) {
        return { ok: false, reason: 'cooling_off ceremony but decision carried no positive coolingOffMs' };
      }
      if (typeof evidence.confirmedAt !== 'number') {
        return { ok: false, reason: 'cooling_off ceremony requires evidence.confirmedAt to measure the elapsed hold' };
      }
      const elapsed = Date.now() - evidence.confirmedAt;
      if (elapsed >= holdMs) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: `cooling_off hold not elapsed: ${elapsed}ms elapsed of required ${holdMs}ms`,
      };
    }

    case 'second_approver':
      if (evidence.approval?.status === 'granted') {
        return { ok: true };
      }
      return {
        ok: false,
        reason: `second_approver ceremony requires an approval with status "granted"; got "${evidence.approval?.status ?? 'none'}"`,
      };

    case 'alert_only':
      // R6: non-blocking. The alert to the owner/admin/security MUST have fired as a side effect; that is
      // the caller's responsibility (this deterministic check cannot observe it). We do not block on it.
      return { ok: true };

    case 'block':
      // R7: terminal. Soft-block pending security review; only a security admin releases it, out of band —
      // never through this path. There is deliberately no branch that admits it.
      return { ok: false, reason: 'block ceremony: terminal — never satisfiable through the supervised-write path' };

    default:
      // Fail-closed on any unknown/future ceremony rather than silently admitting it.
      return { ok: false, reason: `unknown ceremony "${String(decision.ceremony)}" — refusing (fail-closed)` };
  }
}

/**
 * Map deterministic {@link DangerFacts} to the verification {@link Blast} radius that selects the Trust
 * Rule strength. `money` when a positive monetary amount is present; `irreversible` when the facts say
 * the action cannot be undone; a read for reads; otherwise a reversible write. (`external` is not
 * inferable from method+path alone, so it is not synthesized here — the manifest supplies it upstream
 * when a route leaves the system.)
 */
export function mapBlast(facts: DangerFacts): Blast {
  if (typeof facts.amountMinor === 'number' && facts.amountMinor > 0) return 'money';
  if (facts.irreversible === true) return 'irreversible';
  if (facts.verbClass === 'read') return 'read';
  return 'reversible';
}

/** Blasts that are MATERIAL — they demand the hardened Trust Rule (V1 AND V2) before executing. */
const MATERIAL: ReadonlySet<Blast> = new Set<Blast>(['money', 'external', 'irreversible']);

/** Parameters for {@link executeSupervisedWrite}. */
export interface SupervisedWriteParams {
  tool: AegisTool;
  args: Record<string, unknown>;
  /** Where/how/as-whom to reach the governed service when (and only when) all gates pass. */
  invoke: InvokeContext;
  /** The danger gate's decision for this action (from evaluateActionGate). */
  decision: DangerDecision;
  /** Proof the required ceremony was completed. */
  evidence: CeremonyEvidence;
  /** Verification wiring — required (V1 + V2) for material writes; ignored for non-material. */
  verify?: {
    deterministic?: boolean;
    independent?: IndependentVerifier;
    proposerModelId?: string;
    deterministicRecheck?: () => Promise<{ value: unknown }>;
    expected?: unknown;
  };
}

/** The outcome of a supervised write: executed (with the governed result) or refused (with the reason). */
export interface SupervisedWriteResult {
  executed: boolean;
  /** Why the write was refused, when `executed` is false. */
  refusedReason?: string;
  /** The verification verdict, when the material-write path ran the Trust Rule. */
  verification?: VerificationVerdict;
  /** The governed HTTP result, present ONLY when `executed` is true. */
  result?: InvokeResult;
}

/**
 * Run one write through the supervised path. FAIL-CLOSED, in order:
 *
 *   (1) CEREMONY — if the ceremony the danger gate demanded is not satisfied by the evidence, REFUSE.
 *       No HTTP call is made.
 *   (2) VERIFIABILITY — compute the blast from the deterministic danger facts; if it is MATERIAL
 *       (money/external/irreversible), run the hardened Trust Rule. If the verdict is not `verified`,
 *       REFUSE (surfacing the verdict). No HTTP call is made.
 *   (3) EXECUTE — ONLY when both (1) and (2) pass, invoke the tool via the GUARDED route. The governed
 *       core still authenticates/authorizes/validates/RLS/audits exactly as for a human — this path adds
 *       controls, it never removes them.
 *
 * The headline invariant: neither the unsatisfied-ceremony branch nor the failed-verification branch ever
 * reaches {@link invokeTool}. Nothing here weakens the route's own PEP/RLS/audit; it only decides whether
 * we are permitted to reach the route at all.
 */
export async function executeSupervisedWrite(
  params: SupervisedWriteParams,
): Promise<SupervisedWriteResult> {
  const { tool, args, invoke, decision, evidence, verify } = params;

  // (1) CEREMONY — the DANGER axis. Missing/insufficient human proof ⇒ refuse, no HTTP call.
  const ceremony = ceremonySatisfied(decision, evidence);
  if (!ceremony.ok) {
    return { executed: false, refusedReason: `ceremony not satisfied: ${ceremony.reason ?? 'refused'}` };
  }

  // (2) VERIFIABILITY — the TRUST axis, but only for MATERIAL writes (money/external/irreversible).
  const facts = deriveDangerFacts(tool, args);
  const blast = mapBlast(facts);

  let verification: VerificationVerdict | undefined;
  if (MATERIAL.has(blast)) {
    verification = await assertTrustForAutonomousWrite(
      {
        blast,
        claim: `${tool.name} ${JSON.stringify(args)}`,
        deterministicRecheck: verify?.deterministicRecheck,
        expected: verify?.expected,
      },
      {
        deterministic: verify?.deterministic,
        independent: verify?.independent,
        proposerModelId: verify?.proposerModelId,
      },
    );
    if (!verification.verified) {
      return {
        executed: false,
        refusedReason: `verification failed for material blast "${blast}": ${verification.reasons.join('; ')}`,
        verification,
      };
    }
  }

  // (3) EXECUTE — both gates passed. NOW (and only now) call the guarded route.
  const result = await invokeTool(tool, args, invoke);
  return { executed: true, result, ...(verification ? { verification } : {}) };
}
