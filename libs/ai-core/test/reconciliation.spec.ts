import {
  buildReconciliationChecks,
  expenseReportTotalCheck,
  runReconciliation,
  EXPENSE_REPORT_TOTAL_CHECK_ID,
  type ReconciliationDataPort,
} from '../src/autonomy/reconciliation';
import type { AuditProposal } from '../src/autonomy/types';

/**
 * RECONCILIATION — the PROPOSE-ONLY autonomous capability (docs/strategy/agentic-operations.md §0).
 *
 * Every case here is OFFLINE + DETERMINISTIC: there is NO LLM, NO network, NO DB. A fake
 * ReconciliationDataPort feeds live-shaped rows; the deterministic check flags only genuine
 * discrepancies; the run wires the V1-only verifier (default), so `reversible` findings verify on the
 * deterministic recompute alone — no model key needed. The ONLY external effect is the proposalSink;
 * the capability has no write/execution path, so no domain write can occur.
 */

/** A fake, in-memory data port: one RECONCILED report and one DISCREPANT report. */
function fakePort(): ReconciliationDataPort {
  return {
    async listExpenseReportTotals() {
      return [
        // Reconciled: declared === computed ⇒ NOT a finding.
        { reportId: 'rpt-ok', declaredTotalMinor: 15000, computedTotalMinor: 15000 },
        // Discrepant: declared 20000 but line items sum to 18500 ⇒ a finding.
        { reportId: 'rpt-bad', declaredTotalMinor: 20000, computedTotalMinor: 18500 },
      ];
    },
    async listUnresolvedDuplicateInvoices() {
      return [
        { invoiceId: 'inv-2', duplicateOf: 'inv-1', invoiceNumber: 'INV-002', amountMinor: 9900, signature: 'sig-abc' },
      ];
    },
    async listOrphanedExpenses() {
      return [{ expenseId: 'exp-9', reportId: 'rpt-deleted', amountMinor: 4200 }];
    },
  };
}

describe('reconciliation — PROPOSE-ONLY, deterministic, V1-only (§0)', () => {
  it('the check flags ONLY the discrepant report (matching report produces no finding)', async () => {
    const check = expenseReportTotalCheck(fakePort());
    expect(check.id).toBe(EXPENSE_REPORT_TOTAL_CHECK_ID);
    expect(check.blast).toBe('reversible'); // propose-only, non-material

    const { findings } = await check.run();
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.subjectRef).toBe('rpt-bad');
    expect(finding.expected).toBe(18500); // computed = ground truth
    expect(finding.observed).toBe(20000); // declared
    expect(finding.recommendation).toMatch(/re-derive/i);
  });

  it('runReconciliation emits exactly one VERIFIED proposal for the discrepant report', async () => {
    const sink = jest.fn((_p: AuditProposal) => {});
    const checks = [expenseReportTotalCheck(fakePort())];

    const report = await runReconciliation({ checks, proposalSink: sink });

    // Exactly one proposal (only the discrepant report), and it was handed to the sink.
    expect(report.counts.total).toBe(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(report.ranByCheck).toEqual({ [EXPENSE_REPORT_TOTAL_CHECK_ID]: 1 });

    // V1 is satisfied for the non-material `reversible` blast ⇒ verified_proposal (no model needed).
    const proposal = report.proposals[0];
    expect(proposal.status).toBe('verified_proposal');
    expect(proposal.verdict.verified).toBe(true);
    expect(proposal.verdict.methods).toContain('deterministic');
    expect(proposal.verdict.methods).not.toContain('dual_control'); // V2 deliberately absent
    expect(report.counts.verified).toBe(1);
    expect(report.counts.needsHuman).toBe(0);
  });

  it('buildReconciliationChecks runs the full suite: expense-total + duplicate-invoice + orphaned-expense', async () => {
    const sink = jest.fn((_p: AuditProposal) => {});
    const report = await runReconciliation({
      checks: buildReconciliationChecks(fakePort()),
      proposalSink: sink,
    });

    // One finding per check (the discrepant report, the flagged duplicate, the orphaned expense).
    expect(report.counts.total).toBe(3);
    expect(report.counts.verified).toBe(3); // all reversible ⇒ V1 verifies
    const refs = report.proposals.map((p) => `${p.checkId}:${p.finding.subjectRef}`).sort();
    expect(refs).toEqual([
      'reconcile.duplicate-invoice:inv-2',
      'reconcile.expense-report-total:rpt-bad',
      'reconcile.orphaned-expense:exp-9',
    ]);
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it('the sink receives the finding as pure data — the discrepancy is carried through intact', async () => {
    let captured: AuditProposal | undefined;
    const checks = [expenseReportTotalCheck(fakePort())];

    await runReconciliation({
      checks,
      proposalSink: (p) => {
        captured = p;
      },
    });

    expect(captured).toBeDefined();
    const proposal = captured as AuditProposal;
    expect(proposal.checkId).toBe(EXPENSE_REPORT_TOTAL_CHECK_ID);
    expect(proposal.finding.subjectRef).toBe('rpt-bad');
    expect(proposal.finding.expected).toBe(18500);
    expect(proposal.finding.observed).toBe(20000);
    expect(proposal.blast).toBe('reversible');
  });

  it('SAFETY PROPERTY: no domain write — the ONLY effect is the sink, and the proposal is inert data', async () => {
    // The port is READ-only (no mutators exist on it), and we prove it is never invoked for writes by
    // making the ONLY method a read that returns fixed rows. The capability calls the sink and nothing
    // else — there is no executor to invoke, and the emitted proposal carries no callable surface.
    const listSpy = jest.fn(async () => [
      { reportId: 'rpt-bad', declaredTotalMinor: 20000, computedTotalMinor: 18500 },
    ]);
    const port: ReconciliationDataPort = {
      listExpenseReportTotals: listSpy,
      listUnresolvedDuplicateInvoices: async () => [],
      listOrphanedExpenses: async () => [],
    };
    const sink = jest.fn((_p: AuditProposal) => {});

    await runReconciliation({ checks: [expenseReportTotalCheck(port)], proposalSink: sink });

    // The port was READ exactly once (the recompute) and never asked to write (it has no writer).
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);

    // Every emitted proposal is plain data — no function-valued property = no hidden execution hook.
    for (const [arg] of sink.mock.calls) {
      const proposal = arg as AuditProposal;
      for (const value of Object.values(proposal)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });
});
