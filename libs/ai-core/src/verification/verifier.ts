/**
 * @aegis/ai-core / verification — the INDEPENDENT VERIFIER (V2), the hardened dual-control check from
 * docs/strategy/agentic-operations.md §0 and §6.1 #1.
 *
 * The body's dual-control was "ideally a different model" — which in practice meant the same family,
 * same blind spots, reading the SAME (possibly poisoned) evidence, so correlated failure was the
 * DEFAULT. §0 makes independence PROVABLE and MANDATORY: the verifier must run on a DIFFERENT model
 * family from the proposer. This class enforces that precondition in code — if the verifier's model id
 * equals the proposer's, it does not even ask the model; it FAILS the independence precondition.
 *
 * The verifier judges the claim ON ITS OWN via the injected {@link LlmClient} (tests pass a stub — no
 * network). It is asked to reach an independent judgment and return APPROVE / REJECT; anything that is
 * not an unambiguous approval is treated as a rejection (fail-closed).
 */

import type { LlmClient } from '../orchestrator/llm-client';
import type { VerificationRequest, VerificationVerdict } from './types';

/**
 * The V2 contract: independently judge a claim and return a verdict. An implementation MUST be able to
 * FAIL closed — a verifier that cannot establish its own independence returns `verified: false`.
 */
export interface IndependentVerifier {
  verify(req: VerificationRequest): Promise<VerificationVerdict>;
}

/** Options for {@link DualControlVerifier}. */
export interface DualControlVerifierOptions {
  /** The injected, provider-agnostic LLM the verifier reasons through (a stub in tests). */
  verifierLlm: LlmClient;
  /** The proposer (maker) model id / family that produced the claim. */
  proposerModelId: string;
  /** The verifier model id / family. Must DIFFER from `proposerModelId` or independence FAILS. */
  verifierModelId: string;
}

/** Substring an unambiguous approval from the verifier LLM must contain (case-insensitive). */
const APPROVE_TOKEN = 'approve';

/**
 * Dual-control verifier that enforces PROVABLE INDEPENDENCE before it will trust its own judgment.
 *
 * Independence precondition (§0, §6.4 #1): identity-SoD != independence-of-judgment. Two distinct
 * principals on the SAME weights are maker and checker in name only, with identical blind spots. So if
 * `verifierModelId === proposerModelId` this verifier refuses — `verified: false`, reason "verifier not
 * independent" — WITHOUT consulting the model.
 */
export class DualControlVerifier implements IndependentVerifier {
  private readonly verifierLlm: LlmClient;
  private readonly proposerModelId: string;
  private readonly verifierModelId: string;

  constructor(opts: DualControlVerifierOptions) {
    this.verifierLlm = opts.verifierLlm;
    this.proposerModelId = opts.proposerModelId;
    this.verifierModelId = opts.verifierModelId;
  }

  async verify(req: VerificationRequest): Promise<VerificationVerdict> {
    // Independence precondition FIRST — a same-model verifier cannot be independent, so we never even
    // ask it. This is the concrete fix for "dual-control is theater against correlated failure".
    if (this.verifierModelId === this.proposerModelId) {
      return {
        verified: false,
        methods: [],
        reasons: [
          `verifier not independent: verifier model "${this.verifierModelId}" is the same as the ` +
            'proposer model (identity-SoD is not independence-of-judgment; a different model family is required)',
        ],
      };
    }

    // Ask the injected verifier LLM to judge the claim ON ITS OWN. It is shown NO tools (this is a pure
    // judgment, not a tool-selection turn), so it must reply with an assistant message: APPROVE/REJECT.
    const choice = await this.verifierLlm.chooseTool({
      userMessage:
        'You are an INDEPENDENT verifier. Judge the following claim on its own merits and reply with ' +
        'exactly APPROVE if it is correct, or REJECT (with a brief reason) if it is not.\n\n' +
        `Claim: ${req.claim}`,
      tools: [],
    });

    const answer = (choice.assistantMessage ?? '').trim();
    const approved = answer.toLowerCase().includes(APPROVE_TOKEN);

    if (!answer) {
      // Missing/empty judgment => fail closed (no confidence schema => forced non-approval, §6.1 #5).
      return {
        verified: false,
        methods: [],
        reasons: [
          `independent verifier (${this.verifierModelId}) returned no judgment; failing closed`,
        ],
      };
    }

    if (approved) {
      return {
        verified: true,
        methods: ['dual_control'],
        reasons: [
          `independent verifier (${this.verifierModelId}, distinct from proposer ${this.proposerModelId}) approved the claim`,
        ],
      };
    }

    return {
      verified: false,
      methods: [],
      reasons: [
        `independent verifier (${this.verifierModelId}) rejected the claim: ${answer}`,
      ],
    };
  }
}
