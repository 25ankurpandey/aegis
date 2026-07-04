import { DualControlVerifier } from '../src/verification/verifier';
import { assertTrustForAutonomousWrite } from '../src/verification/trust-rule';
import type { VerificationRequest } from '../src/verification/types';
import type { LlmClient, LlmChooseToolInput, LlmToolChoice } from '../src/orchestrator/llm-client';

/**
 * The VERIFIABILITY layer — the hardened Trust Rule (docs/strategy/agentic-operations.md §0, §6.1).
 * Every case here is OFFLINE and DETERMINISTIC: the independent verifier's LLM is a stub, so no
 * network. The rule is an AND for material writes (money/external/irreversible): BOTH a deterministic
 * recompute that reproduces `expected` AND a provably-independent (different-model) dual-control pass.
 * `sampled` alone is forbidden for material writes; a single method suffices for reversible/read.
 */

/** A stub LLM that always returns the given assistant message (no tools, no network). */
function stubLlm(assistantMessage: string): LlmClient {
  return {
    async chooseTool(_input: LlmChooseToolInput): Promise<LlmToolChoice> {
      return { assistantMessage };
    },
  };
}

/** A stub LLM that fails the test if it is ever consulted (used to prove the same-model short-circuit). */
function neverCalledLlm(): LlmClient {
  return {
    async chooseTool(_input: LlmChooseToolInput): Promise<LlmToolChoice> {
      throw new Error('verifier LLM must not be consulted when independence precondition fails');
    },
  };
}

describe('DualControlVerifier — provable independence (§0, §6.1 #1)', () => {
  it('same model id ⇒ NOT verified, without consulting the model', async () => {
    const verifier = new DualControlVerifier({
      verifierLlm: neverCalledLlm(),
      proposerModelId: 'acme-large-v1',
      verifierModelId: 'acme-large-v1',
    });
    const verdict = await verifier.verify({ blast: 'money', claim: '$1,000 owed to vendor 42' });
    expect(verdict.verified).toBe(false);
    expect(verdict.methods).toEqual([]);
    expect(verdict.reasons.join(' ')).toMatch(/not independent/i);
  });

  it('different model + APPROVE ⇒ verified via dual_control', async () => {
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('APPROVE'),
      proposerModelId: 'acme-large-v1',
      verifierModelId: 'other-family-v2',
    });
    const verdict = await verifier.verify({ blast: 'money', claim: '$1,000 owed to vendor 42' });
    expect(verdict.verified).toBe(true);
    expect(verdict.methods).toContain('dual_control');
  });

  it('different model + REJECT ⇒ not verified, reason carries the rejection', async () => {
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('REJECT — the vendor id does not resolve to the cited entity'),
      proposerModelId: 'acme-large-v1',
      verifierModelId: 'other-family-v2',
    });
    const verdict = await verifier.verify({ blast: 'money', claim: '$1,000 owed to vendor 42' });
    expect(verdict.verified).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/rejected/i);
  });

  it('empty judgment ⇒ fail closed', async () => {
    const verifier = new DualControlVerifier({
      verifierLlm: stubLlm('   '),
      proposerModelId: 'acme-large-v1',
      verifierModelId: 'other-family-v2',
    });
    const verdict = await verifier.verify({ blast: 'money', claim: 'x' });
    expect(verdict.verified).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/no judgment|failing closed/i);
  });
});

describe('assertTrustForAutonomousWrite — hardened Trust Rule is an AND (§0, §6.1 #4)', () => {
  const independentApprover = new DualControlVerifier({
    verifierLlm: stubLlm('APPROVE'),
    proposerModelId: 'acme-large-v1',
    verifierModelId: 'other-family-v2',
  });

  it('money write with SAMPLED-ONLY (no V1, no V2) ⇒ REFUSED', async () => {
    const req: VerificationRequest = {
      blast: 'money',
      claim: 'pay vendor 42 $1,000',
      expected: 100000,
    };
    const verdict = await assertTrustForAutonomousWrite(req, { deterministic: false });
    expect(verdict.verified).toBe(false);
    expect(verdict.methods).toEqual([]);
    const reasons = verdict.reasons.join(' ');
    expect(reasons).toMatch(/requires a deterministic recompute/i);
    expect(reasons).toMatch(/sampled-alone is forbidden|independent dual-control/i);
  });

  it('money write with V1 match + V2 (different model) pass ⇒ VERIFIED with both methods', async () => {
    const req: VerificationRequest = {
      blast: 'money',
      claim: 'pay vendor 42 $1,000',
      deterministicRecheck: async () => ({ value: { amountMinor: 100000, vendorId: 42 } }),
      expected: { amountMinor: 100000, vendorId: 42 },
    };
    const verdict = await assertTrustForAutonomousWrite(req, {
      deterministic: true,
      independent: independentApprover,
    });
    expect(verdict.verified).toBe(true);
    expect(verdict.methods).toContain('deterministic');
    expect(verdict.methods).toContain('dual_control');
    expect(verdict.reasons.join(' ')).toMatch(/hardened Trust Rule satisfied/i);
  });

  it('money write with V2 pass but deterministic MISMATCH ⇒ NOT verified', async () => {
    const req: VerificationRequest = {
      blast: 'money',
      claim: 'pay vendor 42 $1,000',
      deterministicRecheck: async () => ({ value: { amountMinor: 999999, vendorId: 42 } }),
      expected: { amountMinor: 100000, vendorId: 42 },
    };
    const verdict = await assertTrustForAutonomousWrite(req, {
      deterministic: true,
      independent: independentApprover,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.methods).not.toContain('deterministic');
    // V2 still passed, so dual_control is recorded, but the AND fails on V1.
    expect(verdict.methods).toContain('dual_control');
    expect(verdict.reasons.join(' ')).toMatch(/did NOT match expected/i);
  });

  it('money write with V1 match but SAME-MODEL verifier ⇒ NOT verified (independence fails)', async () => {
    const sameModelVerifier = new DualControlVerifier({
      verifierLlm: stubLlm('APPROVE'),
      proposerModelId: 'acme-large-v1',
      verifierModelId: 'acme-large-v1',
    });
    const req: VerificationRequest = {
      blast: 'money',
      claim: 'pay vendor 42 $1,000',
      deterministicRecheck: async () => ({ value: 100000 }),
      expected: 100000,
    };
    const verdict = await assertTrustForAutonomousWrite(req, {
      deterministic: true,
      independent: sameModelVerifier,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.methods).toEqual(['deterministic']);
    expect(verdict.reasons.join(' ')).toMatch(/not independent/i);
  });

  it('reversible write with a SINGLE method (deterministic only) ⇒ verified', async () => {
    const req: VerificationRequest = {
      blast: 'reversible',
      claim: 'set draft flag on invoice 7',
      deterministicRecheck: async () => ({ value: true }),
      expected: true,
    };
    const verdict = await assertTrustForAutonomousWrite(req, { deterministic: true });
    expect(verdict.verified).toBe(true);
    expect(verdict.methods).toEqual(['deterministic']);
    expect(verdict.reasons.join(' ')).toMatch(/single verification method suffices/i);
  });

  it('read blast with a single independent (different-model) pass ⇒ verified', async () => {
    const req: VerificationRequest = { blast: 'read', claim: 'AR total is $12,340' };
    const verdict = await assertTrustForAutonomousWrite(req, { independent: independentApprover });
    expect(verdict.verified).toBe(true);
    expect(verdict.methods).toEqual(['dual_control']);
  });

  it('reversible write with NO method satisfied ⇒ not verified', async () => {
    const req: VerificationRequest = { blast: 'reversible', claim: 'noop' };
    const verdict = await assertTrustForAutonomousWrite(req, {});
    expect(verdict.verified).toBe(false);
    expect(verdict.methods).toEqual([]);
    expect(verdict.reasons.join(' ')).toMatch(/no verification method was satisfied/i);
  });
});
