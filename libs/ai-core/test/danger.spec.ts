import { classifyDanger } from '../src/danger/danger-classifier';
import { decideCeremony } from '../src/danger/danger-policy';
import { evaluateActionGate, requiredStepsBeforeInvoke } from '../src/danger/danger-gate';
import type { DangerFacts } from '../src/danger/types';

/**
 * The DANGER / HITL gating layer — the SECOND axis (orthogonal to authorization). Every case here is
 * DETERMINISTIC and OFFLINE (no LLM, no network): the classifier is a pure function of DangerFacts and
 * the policy a pure function of the assessment + context. Anomaly may only RAISE, never solo-gate or
 * lower. Single-human tenants degrade to out-of-band + review queue, never self-approval.
 */
describe('danger classifier — deterministic scoring', () => {
  it('benign single-row read ⇒ level 0 / allow', () => {
    const facts: DangerFacts = { verbClass: 'read', resourceClass: 'invoice', count: 1 };
    const decision = evaluateActionGate(facts, {});
    expect(decision.level).toBe(0);
    expect(decision.ceremony).toBe('allow');
    expect(decision.requiresHuman).toBe(false);
    expect(requiredStepsBeforeInvoke(decision)).toEqual([]);
  });

  it('bulk delete (high count) ⇒ typed_confirm with a phrase encoding the blast radius + escalation', () => {
    const facts: DangerFacts = { verbClass: 'delete', resourceClass: 'invoice', count: 4211 };
    const decision = evaluateActionGate(facts, {});
    // blastRadius maxes at 4 ⇒ level 4.
    expect(decision.level).toBeGreaterThanOrEqual(4);
    expect(decision.typedConfirmationPhrase).toBe('DELETE 4211 invoice');
    // escalated beyond a plain confirm.
    expect(['typed_confirm', 'step_up', 'second_approver', 'block']).toContain(decision.ceremony);
  });

  it('mass irreversible payment over cap ⇒ requires a human (second_approver)', () => {
    const facts: DangerFacts = {
      verbClass: 'execute',
      resourceClass: 'payment',
      count: 1,
      amountMinor: 200_000_000, // $2M
      irreversible: true,
    };
    const decision = evaluateActionGate(facts, { approverPoolSize: 3 });
    expect(decision.assessment.dimensions.monetary).toBe(4);
    expect(decision.requiresHuman).toBe(true);
    expect(decision.ceremony).toBe('second_approver');
    expect(decision.requiresOutOfBand).toBeUndefined();
  });

  it('PII bulk export ⇒ step_up (and mass PII ⇒ second_approver)', () => {
    const modest: DangerFacts = {
      verbClass: 'read',
      resourceClass: 'customer',
      count: 500,
      dataSensitivity: 'pii',
    };
    const d1 = evaluateActionGate(modest, {});
    expect(d1.assessment.dimensions.sensitivity).toBe(3);
    expect(['step_up', 'second_approver']).toContain(d1.ceremony);

    const mass: DangerFacts = {
      verbClass: 'read',
      resourceClass: 'customer',
      count: 82_000,
      dataSensitivity: 'pii',
    };
    const d2 = evaluateActionGate(mass, { approverPoolSize: 3 });
    expect(d2.assessment.dimensions.sensitivity).toBe(4);
    expect(d2.ceremony).toBe('second_approver');
    expect(d2.typedConfirmationPhrase).toBe('READ 82000 customer');
  });

  it('regulatory change (audit retention) ⇒ second_approver; irreversible regulatory ⇒ block', () => {
    const reversible: DangerFacts = {
      verbClass: 'update',
      resourceClass: 'audit_config',
      count: 1,
      regulatory: true,
    };
    const d1 = evaluateActionGate(reversible, { approverPoolSize: 3 });
    expect(d1.assessment.dimensions.regulatory).toBe(3);
    expect(d1.ceremony).toBe('second_approver');

    const irreversible: DangerFacts = {
      verbClass: 'update',
      resourceClass: 'retention_policy',
      count: 1,
      regulatory: true,
      irreversible: true,
    };
    const d2 = evaluateActionGate(irreversible, { approverPoolSize: 3 });
    expect(d2.assessment.dimensions.regulatory).toBe(4);
    expect(d2.ceremony).toBe('block');
    expect(d2.reviewQueue).toBe(true);
    expect(d2.requiresHuman).toBe(true);
  });

  it('riskTier 4 always requires a human even at low danger', () => {
    const facts: DangerFacts = {
      verbClass: 'create',
      resourceClass: 'payment',
      count: 1,
      amountMinor: 100, // $1, danger dim ~0
      riskTier: 4,
    };
    const decision = evaluateActionGate(facts, { approverPoolSize: 3 });
    expect(decision.requiresHuman).toBe(true);
    expect(decision.ceremony).toBe('second_approver');
  });

  it('danger ESCALATES a Tier-2 reversible action to at least confirm', () => {
    const facts: DangerFacts = {
      verbClass: 'update',
      resourceClass: 'invoice',
      count: 30, // blastRadius bucket ⇒ 2 ⇒ level 2
      riskTier: 2,
    };
    const decision = evaluateActionGate(facts, {});
    expect(decision.level).toBeGreaterThanOrEqual(2);
    // A Tier-2 tool alone would be near-autonomous; danger forces at least a confirm.
    expect(decision.ceremony).not.toBe('allow');
  });
});

describe('anomaly — additional trigger only, never sole gate, never lowers', () => {
  const base: DangerFacts = { verbClass: 'read', resourceClass: 'report', count: 1 };

  it('raises the level but only by the capped bump', () => {
    const withAnomaly = evaluateActionGate(
      { ...base, anomaly: { score: 0.95, reason: 'new geo at 3am' } },
      {},
    );
    const without = evaluateActionGate(base, {});
    expect(withAnomaly.level).toBeGreaterThan(without.level);
    expect(withAnomaly.level - without.level).toBeLessThanOrEqual(1);
  });

  it('never lowers the level', () => {
    const dangerous: DangerFacts = { verbClass: 'delete', resourceClass: 'invoice', count: 4211 };
    const noAnomaly = evaluateActionGate(dangerous, {});
    const lowAnomaly = evaluateActionGate({ ...dangerous, anomaly: { score: 0.0 } }, {});
    expect(lowAnomaly.level).toBe(noAnomaly.level);
    expect(lowAnomaly.level).toBeGreaterThanOrEqual(4);
  });

  it('cannot by itself require a human (no deterministic dim ≥ 3 ⇒ downgraded from second_approver)', () => {
    // A low-danger action whose anomaly would push level to 2; ensure it never reaches a human gate
    // solely on anomaly. Force the scenario with an aggressive bump cap.
    const facts: DangerFacts = {
      verbClass: 'update',
      resourceClass: 'note',
      count: 1,
      anomaly: { score: 1.0, reason: 'impossible travel' },
    };
    const decision = evaluateActionGate(facts, {
      classifierOptions: { anomalyBumpCap: 2 },
    });
    // deterministic max here is 1 (update); anomaly bump +2 ⇒ level 3, base ceremony step_up.
    // The anomaly guard ensures we never require a human on anomaly alone.
    expect(decision.requiresHuman).toBe(false);
    expect(['confirm', 'typed_confirm', 'step_up']).toContain(decision.ceremony);
  });
});

describe('single-human tenant — out-of-band + review queue, never self-approval', () => {
  it('approverPoolSize 1 degrades second_approver to out-of-band + review queue', () => {
    const facts: DangerFacts = {
      verbClass: 'execute',
      resourceClass: 'payment',
      count: 1,
      amountMinor: 200_000_000,
      irreversible: true,
    };
    const decision = evaluateActionGate(facts, { approverPoolSize: 1 });
    expect(decision.ceremony).toBe('second_approver');
    expect(decision.requiresOutOfBand).toBe(true);
    expect(decision.reviewQueue).toBe(true);
    expect(decision.requiresHuman).toBe(true);
    // Crucially, it is NOT a plain allow / self-approval.
    expect(decision.ceremony).not.toBe('allow');
    const steps = requiredStepsBeforeInvoke(decision);
    expect(steps.some((s) => /out-of-band/i.test(s.detail))).toBe(true);
  });

  it('undefined approver pool fails SAFE to the single-human degrade (never self-approval)', () => {
    const facts: DangerFacts = {
      verbClass: 'update',
      resourceClass: 'audit_config',
      count: 1,
      regulatory: true,
    };
    const decision = evaluateActionGate(facts, {}); // no approverPoolSize
    expect(decision.ceremony).toBe('second_approver');
    expect(decision.requiresOutOfBand).toBe(true);
    expect(decision.reviewQueue).toBe(true);
  });
});

describe('agent-initiated danger (§3.4)', () => {
  it('agent-proposed action at level ≥ 2 escalates to a human', () => {
    const facts: DangerFacts = { verbClass: 'update', resourceClass: 'invoice', count: 30, riskTier: 2 };
    const human = evaluateActionGate(facts, {});
    const agent = evaluateActionGate(facts, { isAgent: true, approverPoolSize: 3 });
    expect(agent.level).toBeGreaterThanOrEqual(2);
    expect(agent.requiresHuman).toBe(true);
    // The human path at the same level does not necessarily require a human.
    expect(human.requiresHuman).toBe(false);
  });
});

describe('determinism — same input ⇒ same output', () => {
  it('classifyDanger and decideCeremony are pure', () => {
    const facts: DangerFacts = {
      verbClass: 'delete',
      resourceClass: 'invoice',
      count: 4211,
      amountMinor: 120_433_000,
      dataSensitivity: 'financial',
      anomaly: { score: 0.9 },
    };
    const a1 = classifyDanger(facts);
    const a2 = classifyDanger(facts);
    expect(a1).toEqual(a2);

    const d1 = decideCeremony(a1, { facts, approverPoolSize: 2 });
    const d2 = decideCeremony(a2, { facts, approverPoolSize: 2 });
    expect(d1).toEqual(d2);

    // And end-to-end through the gate.
    expect(evaluateActionGate(facts, { approverPoolSize: 2 })).toEqual(
      evaluateActionGate(facts, { approverPoolSize: 2 }),
    );
  });
});
