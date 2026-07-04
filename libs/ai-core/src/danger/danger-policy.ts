import type {
  Ceremony,
  DangerAssessment,
  DangerDecision,
  DangerFacts,
  DangerLevel,
} from './types';

/**
 * @aegis/ai-core / danger — the danger POLICY (docs/strategy §3.2, §3.3, §0, §6).
 *
 * `decideCeremony` maps a deterministic `DangerAssessment` to a `DangerDecision`: the friction ladder
 * (R0..R7) plus the deterministic ESCALATIONS and the composition rule with the tool's risk tier.
 *
 * Invariants this layer preserves:
 *   - Danger NEVER authorizes; it only adds friction. It can only TIGHTEN, never loosen (§3.3): the
 *     composed gate is the most-restrictive of the danger stack and the tier baseline.
 *   - Hard human gates (second_approver / block) require a DETERMINISTIC dimension ≥ 3 — the anomaly
 *     bump alone can never cause them (§3.1). Anomaly can push a D1→D2 confirm→typed_confirm/step_up,
 *     but cannot solo-block legitimate work.
 *   - SINGLE-HUMAN tenants NEVER collapse a second_approver into silent self-approval (§0, §6.3,
 *     §6.7): when approverPoolSize ≤ 1 we degrade to out-of-band confirmation + platform review queue.
 *   - Typed-confirmation phrase encodes the TRUE blast radius (from server-derived facts), so it
 *     doubles as proof the human saw the scale; a stale count (re-checked at execute) voids it (§3.2).
 */

/** Context the policy needs beyond the pure assessment. */
export interface DangerPolicyContext {
  facts: DangerFacts;
  /**
   * How many DISTINCT humans could serve as the second approver for this action (excluding the
   * requester). ≤ 1 ⇒ the single-human degrade path. Undefined is treated as unknown-but-adequate
   * only for non-human-required decisions; when a human IS required and this is undefined we fail SAFE
   * by treating it as a single-human tenant (out-of-band + review queue), never as self-approval.
   */
  approverPoolSize?: number;
  /**
   * True iff the initiating principal is an autonomous AGENT (not a human session). Per §3.4 any
   * agent-proposed action at level ≥ 2 escalates to a human regardless of autonomy tier — the agent
   * cannot click or type its own confirmation.
   */
  isAgent?: boolean;
}

/** The ordered friction ladder — index = strictness, so composition is a `max` of indices. */
const LADDER: Ceremony[] = [
  'allow',
  'confirm',
  'typed_confirm',
  'step_up',
  'second_approver',
  'block',
];

function strictnessOf(c: Ceremony): number {
  const i = LADDER.indexOf(c);
  return i === -1 ? 0 : i;
}

/** The most restrictive of two ceremonies (danger never de-escalates). */
function tighter(a: Ceremony, b: Ceremony): Ceremony {
  return strictnessOf(a) >= strictnessOf(b) ? a : b;
}

/** Base ceremony from the danger level alone (§3.2 default mapping). */
function baseCeremony(level: DangerLevel): Ceremony {
  switch (level) {
    case 0:
      return 'allow';
    case 1:
      return 'confirm';
    case 2:
      return 'typed_confirm';
    case 3:
      return 'step_up';
    case 4:
    case 5:
    default:
      return 'second_approver';
  }
}

/** Tier baseline (§3.3): Tier 4 tools always require a human approver, even at low danger. */
function tierBaseline(tier: DangerFacts['riskTier']): Ceremony {
  switch (tier) {
    case 4:
      return 'second_approver';
    case 3:
      return 'confirm';
    default:
      return 'allow';
  }
}

/** The server-generated typed-confirmation phrase encoding the true blast radius. */
function typedPhrase(facts: DangerFacts): string {
  const verb = facts.verbClass.toUpperCase();
  const count = facts.count ?? 1;
  return `${verb} ${count} ${facts.resourceClass}`;
}

export function decideCeremony(
  assessment: DangerAssessment,
  ctx: DangerPolicyContext,
): DangerDecision {
  const { facts } = ctx;
  const level = assessment.level;
  const reasons: string[] = [];
  const alertRoles = new Set<string>();

  const irreversible = facts.irreversible === true;
  const isMoney = typeof facts.amountMinor === 'number' && facts.amountMinor > 0;
  const isBulk = (facts.count ?? 1) >= 2;
  const deterministicMax = Math.max(
    assessment.dimensions.destructiveness ?? 0,
    assessment.dimensions.blastRadius ?? 0,
    assessment.dimensions.monetary ?? 0,
    assessment.dimensions.sensitivity ?? 0,
    assessment.dimensions.regulatory ?? 0,
  );

  // 1. Start from the danger-level base, composed (tightened) with the tier baseline (§3.3).
  let ceremony = tighter(baseCeremony(level), tierBaseline(facts.riskTier));
  if (facts.riskTier === 4) reasons.push('tier: Tier-4 tool always requires a human approver');

  let coolingOffMs: number | undefined;
  let typedConfirmationPhrase: string | undefined;

  // 2. Deterministic ESCALATIONS (applied on top; §3.2 overrides). Each can only TIGHTEN.

  // Regulatory (audit/retention/permissions/compliance): second_approver, or block if irreversible.
  if (assessment.dimensions.regulatory && assessment.dimensions.regulatory >= 4) {
    ceremony = tighter(ceremony, 'block');
    reasons.push('regulatory: irreversible regulatory change ⇒ block pending review');
    alertRoles.add('security');
    alertRoles.add('owner');
  } else if (assessment.dimensions.regulatory && assessment.dimensions.regulatory >= 3) {
    ceremony = tighter(ceremony, 'second_approver');
    reasons.push('regulatory: touching audit/retention/permissions ⇒ second approver');
    alertRoles.add('security');
  }

  // riskTier 4 OR irreversible-money ALWAYS requires a human (second_approver).
  if (facts.riskTier === 4 || (irreversible && isMoney)) {
    ceremony = tighter(ceremony, 'second_approver');
    if (irreversible && isMoney) reasons.push('escalation: irreversible money ⇒ second approver');
  }

  // Money / irreversible BULK ⇒ typed_confirm + step_up + second_approver.
  if ((isMoney || irreversible) && isBulk && deterministicMax >= 3) {
    ceremony = tighter(ceremony, 'second_approver');
    typedConfirmationPhrase = typedPhrase(facts);
    reasons.push('escalation: money/irreversible bulk ⇒ typed confirm + step-up + second approver');
  }

  // Destructive bulk (delete/execute of many rows) ⇒ typed_confirm phrase.
  if (
    (facts.verbClass === 'delete' || facts.verbClass === 'execute') &&
    isBulk &&
    (assessment.dimensions.blastRadius ?? 0) >= 2
  ) {
    ceremony = tighter(ceremony, 'typed_confirm');
    typedConfirmationPhrase = typedPhrase(facts);
    reasons.push('escalation: destructive bulk ⇒ typed confirmation phrase');
  }

  // PII / financial export ⇒ step_up (heavier at high sensitivity score).
  if (
    facts.verbClass === 'read' &&
    (facts.dataSensitivity === 'pii' || facts.dataSensitivity === 'financial') &&
    (assessment.dimensions.sensitivity ?? 0) >= 1
  ) {
    ceremony = tighter(ceremony, 'step_up');
    reasons.push('escalation: PII/financial export ⇒ step-up');
    alertRoles.add('security');
    if ((assessment.dimensions.sensitivity ?? 0) >= 4) {
      ceremony = tighter(ceremony, 'second_approver');
      typedConfirmationPhrase = typedPhrase(facts);
      reasons.push('escalation: mass PII export ⇒ typed confirm + second approver');
    }
  }

  // 3. Cooling-off (R4) for level-4 reversible actions (announces the window so hijacks are visible).
  if (level >= 4 && !irreversible) {
    coolingOffMs = 15 * 60 * 1000;
    reasons.push('cooling-off: level ≥ 4 reversible ⇒ 15-min staged UNDO window');
  }

  // 4. ANOMALY-ONLY GUARD: a hard human gate must rest on a deterministic dimension ≥ 3. If the only
  //    reason we reached second_approver/block is the anomaly bump, step it DOWN to step_up — anomaly
  //    can add confirmation/step-up/alert but never solo-block or solo-require an approver (§3.1).
  if (strictnessOf(ceremony) >= strictnessOf('second_approver') && deterministicMax < 3 && facts.riskTier !== 4) {
    ceremony = 'step_up';
    reasons.push('anomaly guard: no deterministic dim ≥ 3 ⇒ anomaly may not solo-require a human');
  }

  // 5. AGENT rule (§3.4): an agent-proposed action at level ≥ 2 escalates its confirm/typed gates to a
  //    human — the agent cannot satisfy its own confirmation.
  if (ctx.isAgent && level >= 2 && strictnessOf(ceremony) < strictnessOf('second_approver')) {
    ceremony = tighter(ceremony, 'second_approver');
    reasons.push('agent: agent-proposed action at level ≥ 2 ⇒ human approver');
  }

  // 6. Alerting (R6) side-channel roles by level (§3.5).
  if (level >= 4) {
    alertRoles.add('owner');
    alertRoles.add('security');
  } else if (level === 3) {
    alertRoles.add('admin');
  }

  const requiresHuman =
    strictnessOf(ceremony) >= strictnessOf('second_approver'); // second_approver or block

  // 7. SINGLE-HUMAN degrade (§0, §6.3, §6.7): a required second approver in a tenant with ≤ 1 eligible
  //    human MUST NOT become self-approval. Degrade to out-of-band confirmation + review queue.
  let requiresOutOfBand: boolean | undefined;
  let reviewQueue: boolean | undefined;
  if (ceremony === 'second_approver') {
    const pool = ctx.approverPoolSize;
    const soloTenant = pool === undefined || pool <= 1;
    if (soloTenant) {
      requiresOutOfBand = true;
      reviewQueue = true;
      reasons.push(
        'single-human: approver pool ≤ 1 ⇒ out-of-band confirmation + platform review queue (NOT self-approval)',
      );
    }
  }
  // `block` is terminal-unless-released by a security admin; it already routes to the review queue.
  if (ceremony === 'block') {
    reviewQueue = true;
  }

  return {
    ceremony,
    level,
    assessment,
    requiresHuman,
    ...(typedConfirmationPhrase ? { typedConfirmationPhrase } : {}),
    ...(coolingOffMs ? { coolingOffMs } : {}),
    ...(alertRoles.size ? { alertRoles: [...alertRoles] } : {}),
    ...(requiresOutOfBand ? { requiresOutOfBand } : {}),
    ...(reviewQueue ? { reviewQueue } : {}),
    reasons: [...assessment.reasons, ...reasons],
  };
}
