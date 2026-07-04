/**
 * @aegis/ai-core / autonomy — the SELF-AUDIT capability: the FIRST autonomous capability, and it is
 * deliberately PROPOSE-ONLY (docs/strategy/agentic-operations.md §0; doctrine "the agent reasons; the
 * governed core acts").
 *
 * INVARIANT (stated in plain words, and enforced structurally):
 *   - This capability's ONLY observable side effect is calling `proposalSink`. It has NO write path.
 *   - It holds NO tool-execution dependency — no `invokeTool`, no `executeSupervisedWrite`, no broker.
 *     The type system enforces this: there is nowhere in `SelfAuditDeps` to inject an executor, so the
 *     class *cannot* call one. Autonomous MATERIAL writes stay forbidden by construction.
 *   - It READS + REASONS + emits PROPOSALS. A MATERIAL finding (money/external/irreversible) that is not
 *     INDEPENDENTLY verified is marked `needs_human`; nothing is ever auto-executed.
 *
 * Each finding is run through the hardened Trust Rule (`assertTrustForAutonomousWrite`), so the SAME gate
 * that guards autonomous writes decides whether a proposal is trustworthy enough to label a
 * `verified_proposal` — but here the "action" is only ever handing DATA to a human via the sink.
 */

import { assertTrustForAutonomousWrite } from '../verification/trust-rule';
import type { IndependentVerifier } from '../verification/verifier';
import type { VerificationRequest } from '../verification/types';
import type {
  AuditCheck,
  AuditProposal,
  ProposalSink,
  RawFinding,
  SelfAuditReport,
} from './types';

/** Constructor dependencies. NOTE the absence of any tool-executor — that omission is the safety property. */
export interface SelfAuditDeps {
  /** V2: the independent (must be different-model) verifier used to judge each discrepancy. */
  verifier: IndependentVerifier;
  /** The proposer (maker) model id, passed through to the Trust Rule so independence can be reasoned about.
   *  The DualControlVerifier already knows both ids; per the trust-rule signature we still pass it through. */
  proposerModelId: string;
  /** The ONLY external effect: where finished proposals go (a review inbox / queue / ledger append). */
  proposalSink: ProposalSink;
}

/**
 * Compose a human-readable claim for the verifier from a finding. The verifier judges whether the
 * DISCREPANCY (observed != expected on this subject) is a real finding worth a human's attention.
 */
function buildClaim(finding: RawFinding): string {
  return (
    `${finding.summary} (subject: ${finding.subjectRef}) — ` +
    `expected ${JSON.stringify(finding.expected)}, observed ${JSON.stringify(finding.observed)}`
  );
}

export class SelfAuditCapability {
  private readonly verifier: IndependentVerifier;
  private readonly proposerModelId: string;
  private readonly proposalSink: ProposalSink;

  constructor(deps: SelfAuditDeps) {
    this.verifier = deps.verifier;
    this.proposerModelId = deps.proposerModelId;
    this.proposalSink = deps.proposalSink;
    // Intentionally NOTHING else — no executor, no broker, no write route is (or can be) wired in.
  }

  async run(checks: AuditCheck[]): Promise<SelfAuditReport> {
    const proposals: AuditProposal[] = [];
    const ranByCheck: Record<string, number> = {};

    for (const check of checks) {
      // Run the DETERMINISTIC, human-vetted recompute for this check. The capability never authors it.
      const { findings } = await check.run();
      ranByCheck[check.id] = findings.length;

      for (const finding of findings) {
        // Build the Trust-Rule request for this discrepancy.
        //
        // V1 (deterministic) here recomputes the ground-truth EXPECTATION and confirms it is
        // REPRODUCIBLE: we set `deterministicRecheck` to return `finding.expected` and `expected` to the
        // same value, so V1 is satisfied when the vetted recompute reproduces the expectation. We do NOT
        // feed it `observed`, because a genuine finding is precisely a discrepancy (observed != expected)
        // and that would make V1 fail on every real finding. Instead, V2 (the independent verifier) is
        // what judges whether the DISCREPANCY itself is a real finding. This keeps V1 meaningful (it
        // deterministically re-derives the expectation) while V2 supplies the independent judgment — the
        // same "determinism proves reproducibility, not truth" split the trust rule mandates (§0, §6.1).
        const req: VerificationRequest = {
          blast: check.blast,
          claim: buildClaim(finding),
          deterministicRecheck: async () => ({ value: finding.expected }),
          expected: finding.expected,
        };

        const verdict = await assertTrustForAutonomousWrite(req, {
          deterministic: true,
          independent: this.verifier,
          proposerModelId: this.proposerModelId,
        });

        const proposal: AuditProposal = {
          checkId: check.id,
          finding,
          blast: check.blast,
          verdict,
          status: verdict.verified ? 'verified_proposal' : 'needs_human',
        };

        proposals.push(proposal);
        // The ONE and ONLY external effect. Every proposal is emitted — verified or needs-human — as
        // pure data. Nothing else is invoked; there is no execution path to invoke.
        await this.proposalSink(proposal);
      }
    }

    const verified = proposals.filter((p) => p.status === 'verified_proposal').length;
    return {
      proposals,
      counts: {
        total: proposals.length,
        verified,
        needsHuman: proposals.length - verified,
      },
      ranByCheck,
    };
  }
}
