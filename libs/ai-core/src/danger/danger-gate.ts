import { classifyDanger, type DangerClassifierOptions } from './danger-classifier';
import { decideCeremony, type DangerPolicyContext } from './danger-policy';
import type { Ceremony, DangerDecision, DangerFacts } from './types';

/**
 * @aegis/ai-core / danger — the DANGER GATE entrypoint (docs/strategy §3, §0).
 *
 * THE SECOND AXIS. Aegis gates every mutation on two ORTHOGONAL axes:
 *
 *   AUTHORIZATION (the PEP / Casbin)  — "are you ALLOWED?"   — runs INDEPENDENTLY, and FIRST.
 *   DANGER (this gate)                — "is it RISKY even if allowed?"
 *
 * This gate runs AFTER a PEP allow and BEFORE the mutation executes inside `withTenantTransaction`.
 * It NEVER authorizes anything — a PEP deny is final and danger cannot override it. Danger only ADDS
 * friction, delay, witnesses, or a block-pending-review on top of an allow, and it can only ever
 * TIGHTEN the gate, never loosen it.
 *
 * The classifier is DETERMINISTIC: the LLM never computes the tier or the level, never sees the
 * thresholds as mutable input, and cannot talk the classifier down (symmetric with the anti-deictic
 * rule). The anomaly signal is advisory — it may raise the level as an additional trigger but is never
 * the sole basis for a hard human gate, and never lowers the level.
 *
 * TOCTOU / no-blank-cheque caveats the caller MUST honor (documented, not enforced here because they
 * need the live tenant tx): re-evaluate at execute time — a same-count-different-rows shift or any
 * count/amount drift voids the challenge and re-runs the whole gate (§3.3, §6.3). Any confirmation
 * memoization must be strictly bounded (never a blank cheque) and never memoize step-up for the top
 * level, regulatory touches, or approvals (§3.6).
 */

/**
 * The gate takes `facts` as its first argument and builds the policy context from it, so this context
 * omits `facts` (it is supplied separately) and adds classifier overrides.
 */
export interface DangerGateContext extends Omit<DangerPolicyContext, 'facts'> {
  /** Optional classifier threshold overrides (per-tenant tightening within platform floors). */
  classifierOptions?: DangerClassifierOptions;
}

/**
 * Classify the facts, then decide the ceremony. Pure and DETERMINISTIC: the same facts + context
 * always yield the same decision (a hard requirement for anti-fatigue predictability and for a ledger
 * a regulator can replay).
 */
export function evaluateActionGate(
  facts: DangerFacts,
  ctx: DangerGateContext,
): DangerDecision {
  const assessment = classifyDanger(facts, ctx.classifierOptions);
  return decideCeremony(assessment, { ...ctx, facts });
}

/** A single required pre-execution step derived from the decision (for the calling gateway to run). */
export interface RequiredStep {
  ceremony: Ceremony;
  /** True iff a human (approver or out-of-band reviewer) must act before execution. */
  human: boolean;
  detail: string;
}

/**
 * Describe, in order, what must happen before `invokeTool` may run for this action. This is a
 * convenience for the execution gateway — it does NOT execute anything; it enumerates the friction the
 * decision imposes so the caller can drive challenges / approvals / cooling-off in the right order.
 * An `allow` decision returns an empty list (R0: execute + log).
 */
export function requiredStepsBeforeInvoke(decision: DangerDecision): RequiredStep[] {
  const steps: RequiredStep[] = [];
  const c = decision.ceremony;

  if (c === 'allow') return steps;

  if (c === 'confirm') {
    steps.push({ ceremony: 'confirm', human: true, detail: 'Inline one-click confirmation of server-computed facts.' });
  }

  if (c === 'typed_confirm' || decision.typedConfirmationPhrase) {
    steps.push({
      ceremony: 'typed_confirm',
      human: true,
      detail: `Type the phrase "${decision.typedConfirmationPhrase ?? '<phrase>'}" (re-checked against live count at execute).`,
    });
  }

  if (c === 'step_up') {
    steps.push({ ceremony: 'step_up', human: true, detail: 'Fresh action-bound WebAuthn/passkey assertion (no session reuse).' });
  }

  if (decision.coolingOffMs) {
    steps.push({
      ceremony: 'cooling_off',
      human: false,
      detail: `Stage execution; wait ${decision.coolingOffMs}ms with one-click UNDO available to watchers.`,
    });
  }

  if (c === 'second_approver') {
    if (decision.requiresOutOfBand) {
      steps.push({
        ceremony: 'second_approver',
        human: true,
        detail:
          'SINGLE-HUMAN tenant: out-of-band (email/SMS) confirmation + platform security-review queue as substitute checker — NOT self-approval.',
      });
    } else {
      steps.push({ ceremony: 'second_approver', human: true, detail: 'Route to @aegis/approvals with approver ≠ requester (SoD).' });
    }
  }

  if (c === 'block') {
    steps.push({
      ceremony: 'block',
      human: true,
      detail: 'Soft-block: park in the platform security-review queue; only a security admin (never the requester) releases it.',
    });
  }

  if (decision.alertRoles?.length) {
    steps.push({ ceremony: 'alert_only', human: false, detail: `Alert roles: ${decision.alertRoles.join(', ')} (non-blocking).` });
  }

  return steps;
}
