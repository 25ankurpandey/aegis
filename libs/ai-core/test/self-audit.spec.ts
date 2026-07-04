import { SelfAuditCapability } from '../src/autonomy/self-audit';
import type { AuditCheck, AuditProposal, RawFinding } from '../src/autonomy/types';
import { DualControlVerifier } from '../src/verification/verifier';
import type { LlmClient, LlmChooseToolInput, LlmToolChoice } from '../src/orchestrator/llm-client';

/**
 * The SELF-AUDIT capability — the FIRST autonomous capability, and it is PROPOSE-ONLY
 * (docs/strategy/agentic-operations.md §0; "the agent reasons; the governed core acts").
 *
 * Every case here is OFFLINE + DETERMINISTIC: the independent verifier's LLM is a stub, so no network.
 * The capability runs vetted deterministic checks, pushes each finding through the hardened Trust Rule,
 * and emits proposals to a sink. Its ONLY external effect is that sink; it has NO write/execution path —
 * a fact the type system enforces (SelfAuditCapability's deps have no executor to inject).
 */

/** A stub LLM that always returns the given assistant message (no tools, no network). */
function stubLlm(assistantMessage: string): LlmClient {
  return {
    async chooseTool(_input: LlmChooseToolInput): Promise<LlmToolChoice> {
      return { assistantMessage };
    },
  };
}

/** Build a single-finding check with a chosen blast. */
function makeCheck(
  id: string,
  blast: AuditCheck['blast'],
  findings: RawFinding[],
): AuditCheck {
  return {
    id,
    description: `check ${id}`,
    blast,
    run: async () => ({ findings }),
  };
}

const MONEY_FINDING: RawFinding = {
  subjectRef: 'invoice-42',
  summary: 'AR balance disagrees with ledger',
  expected: { amountMinor: 100000, vendorId: 42 },
  observed: { amountMinor: 999999, vendorId: 42 },
  recommendation: 'Reconcile invoice-42 against the ledger before month close',
};

const REVERSIBLE_FINDING: RawFinding = {
  subjectRef: 'invoice-7',
  summary: 'draft flag should be set',
  expected: true,
  observed: false,
  recommendation: 'Set the draft flag on invoice-7',
};

describe('SelfAuditCapability — PROPOSE-ONLY self-audit (§0)', () => {
  it('1. runs checks deterministically → findings produced; counts + ranByCheck correct', async () => {
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('APPROVE'),
      proposerModelId: 'gpt-x',
      verifierModelId: 'claude-y',
    });
    const cap = new SelfAuditCapability({ verifier, proposerModelId: 'gpt-x', proposalSink: () => {} });

    const checkA = makeCheck('check-a', 'money', [MONEY_FINDING]);
    const checkB = makeCheck('check-b', 'reversible', [REVERSIBLE_FINDING, REVERSIBLE_FINDING]);
    const report = await cap.run([checkA, checkB]);

    expect(report.counts.total).toBe(3);
    expect(report.ranByCheck).toEqual({ 'check-a': 1, 'check-b': 2 });
    expect(report.proposals).toHaveLength(3);
  });

  it('2. MATERIAL (money) + independent APPROVE ⇒ verified_proposal with both methods', async () => {
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('APPROVE'),
      proposerModelId: 'gpt-x',
      verifierModelId: 'claude-y',
    });
    const cap = new SelfAuditCapability({ verifier, proposerModelId: 'gpt-x', proposalSink: () => {} });

    const report = await cap.run([makeCheck('c', 'money', [MONEY_FINDING])]);
    const proposal = report.proposals[0];

    expect(proposal.status).toBe('verified_proposal');
    expect(proposal.verdict.verified).toBe(true);
    expect(proposal.verdict.methods).toContain('deterministic');
    expect(proposal.verdict.methods).toContain('dual_control');
    expect(report.counts.verified).toBe(1);
    expect(report.counts.needsHuman).toBe(0);
  });

  it('3. MATERIAL (money) + NON-independent verifier (same model id) ⇒ needs_human', async () => {
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('APPROVE'),
      proposerModelId: 'gpt-x',
      verifierModelId: 'gpt-x', // identity-SoD is not independence ⇒ V2 fails closed
    });
    const cap = new SelfAuditCapability({ verifier, proposerModelId: 'gpt-x', proposalSink: () => {} });

    const report = await cap.run([makeCheck('c', 'money', [MONEY_FINDING])]);
    const proposal = report.proposals[0];

    expect(proposal.verdict.verified).toBe(false);
    expect(proposal.status).toBe('needs_human');
    expect(proposal.verdict.reasons.join(' ')).toMatch(/not independent/i);
  });

  it('4. MATERIAL (money) + different-model verifier that REJECTS ⇒ needs_human', async () => {
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('REJECT: the discrepancy is a stale snapshot, not a real finding'),
      proposerModelId: 'gpt-x',
      verifierModelId: 'claude-y',
    });
    const cap = new SelfAuditCapability({ verifier, proposerModelId: 'gpt-x', proposalSink: () => {} });

    const report = await cap.run([makeCheck('c', 'money', [MONEY_FINDING])]);
    const proposal = report.proposals[0];

    expect(proposal.status).toBe('needs_human');
    expect(proposal.verdict.verified).toBe(false);
    expect(proposal.verdict.reasons.join(' ')).toMatch(/rejected/i);
  });

  it('5. NON-material (reversible) with V1 satisfied ⇒ verified_proposal even if verifier REJECTS', async () => {
    // A single method suffices for non-material blasts; V1 (deterministic) alone verifies here.
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('REJECT: not consulted meaningfully for this tier'),
      proposerModelId: 'gpt-x',
      verifierModelId: 'claude-y',
    });
    const cap = new SelfAuditCapability({ verifier, proposerModelId: 'gpt-x', proposalSink: () => {} });

    const report = await cap.run([makeCheck('c', 'reversible', [REVERSIBLE_FINDING])]);
    const proposal = report.proposals[0];

    expect(proposal.status).toBe('verified_proposal');
    expect(proposal.verdict.verified).toBe(true);
    expect(proposal.verdict.methods).toContain('deterministic');
  });

  it('6. SAFETY PROPERTY: the ONLY external effect is proposalSink — called once per finding, data only', async () => {
    // The type system enforces this: SelfAuditCapability has no executor dependency, so there is no
    // execution path to invoke. We additionally prove at runtime that the sink is the sole effect.
    const sink = jest.fn((_p: AuditProposal) => {});
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('APPROVE'),
      proposerModelId: 'gpt-x',
      verifierModelId: 'claude-y',
    });
    const cap = new SelfAuditCapability({ verifier, proposerModelId: 'gpt-x', proposalSink: sink });

    const checkA = makeCheck('check-a', 'money', [MONEY_FINDING]);
    const checkB = makeCheck('check-b', 'reversible', [REVERSIBLE_FINDING, REVERSIBLE_FINDING]);
    const report = await cap.run([checkA, checkB]);

    // One sink call per finding (3 findings total), and nothing else was invoked.
    expect(sink).toHaveBeenCalledTimes(3);
    expect(report.counts.total).toBe(3);

    // Every emitted proposal is plain data — no callable / execution surface leaked onto it.
    for (const [arg] of sink.mock.calls) {
      const proposal = arg as AuditProposal;
      expect(typeof proposal.checkId).toBe('string');
      expect(proposal).toHaveProperty('finding');
      expect(proposal).toHaveProperty('verdict');
      expect(['verified_proposal', 'needs_human']).toContain(proposal.status);
      // No function-valued property means no hidden execution hook on the proposal.
      for (const value of Object.values(proposal)) {
        expect(typeof value).not.toBe('function');
      }
    }

    // Construction-level assertion: the capability exposes no executor-shaped surface.
    expect((cap as unknown as Record<string, unknown>).invokeTool).toBeUndefined();
    expect((cap as unknown as Record<string, unknown>).executeSupervisedWrite).toBeUndefined();
  });
});
