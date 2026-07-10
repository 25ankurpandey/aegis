/**
 * @aegis/ai-core / autonomy — RECONCILIATION: a real, PROPOSE-ONLY autonomous capability built on top
 * of the SelfAuditCapability (docs/strategy/agentic-operations.md §0; doctrine "the agent reasons; the
 * governed core acts").
 *
 * It runs VETTED, DETERMINISTIC checks over LIVE data, routes each VERIFIED finding as a PROPOSAL into
 * the app-brain (kind `audit_finding`) for a human to adjudicate, and NEVER writes to the domain. It
 * carries no write-capable surface: the only external effect is the injected {@link ProposalSink}.
 *
 * WHY IT NEEDS NO MODEL KEY. The reconciliation checks are DETERMINISTIC recomputes (a declared total
 * vs. the recomputed sum of line items). Because the capability is propose-only, the "write" a finding
 * would propose is non-material (blast `reversible`) — nothing leaves the system, nothing moves money,
 * nothing is irreversible. The hardened Trust Rule (§0) requires the V1-AND-V2 pairing ONLY for
 * MATERIAL blasts; for a `reversible` blast a single satisfied method suffices, so V1 (the deterministic
 * recompute) alone verifies. That is exactly what {@link runReconciliation} wires by default: a V1-only
 * verifier, so the capability runs offline with NO LLM key. A caller who wants an independent model
 * judgment in the loop can inject a {@link IndependentVerifier} (e.g. a DualControlVerifier) explicitly.
 *
 * SEPARATION FROM THE DB. This file has NO direct DB import. Data access is an injected, RLS-scoped
 * seam ({@link ReconciliationDataPort}) so the check logic stays pure and testable offline. The bridge
 * to the app-brain ({@link appBrainProposalSink}) is the ONLY place that touches @aegis/db, and even
 * there it only READS proposals and REMEMBERS them as recallable memories — never a domain mutation.
 */

import { SelfAuditCapability } from './self-audit';
import type { AuditCheck, AuditProposal, ProposalSink, RawFinding, SelfAuditReport } from './types';
import type { IndependentVerifier } from '../verification/verifier';
import type { VerificationRequest, VerificationVerdict } from '../verification/types';
import { indexAuditProposal, type AppBrainService } from '@aegis/db';

/**
 * The RLS-scoped data-access seam the reconciliation checks read through. Injected so this module has
 * NO direct DB dependency: the concrete implementation (raw SQL, an ORM, a fake) lives at the edges and
 * is responsible for tenant scoping. Amounts are in MINOR units (integer cents) to avoid float drift.
 */
export interface ReconciliationDataPort {
  /**
   * List every expense report with BOTH its declared total and the total recomputed from its line
   * items (the ground truth). A genuine finding is any row where `declaredTotalMinor` disagrees with
   * `computedTotalMinor`.
   */
  listExpenseReportTotals(): Promise<
    Array<{ reportId: string; declaredTotalMinor: number; computedTotalMinor: number }>
  >;
  /**
   * List invoices carrying an UNRESOLVED (`flagged`) duplicate record — each is already a finding
   * (a potential double-payment) awaiting a human's adjudication.
   */
  listUnresolvedDuplicateInvoices(): Promise<
    Array<{ invoiceId: string; duplicateOf: string | null; invoiceNumber: string; amountMinor: number; signature: string }>
  >;
  /**
   * List expense line items still attached to a SOFT-DELETED report (referential-integrity drift) —
   * each is a finding: an orphaned amount that should be reattached or removed.
   */
  listOrphanedExpenses(): Promise<
    Array<{ expenseId: string; reportId: string; amountMinor: number }>
  >;
}

/** The stable check id for the expense-report total reconciliation (used as the memory `ref` prefix). */
export const EXPENSE_REPORT_TOTAL_CHECK_ID = 'reconcile.expense-report-total';

/**
 * A vetted, DETERMINISTIC check: flag any expense report whose DECLARED total disagrees with the
 * COMPUTED sum of its line items. blast `reversible` — the proposed remediation (re-derive the header
 * total) is cheaply undoable and never leaves the system, so it is propose-only + non-material.
 *
 * `expected` is the recomputed ground truth; `observed` is the declared value on the report; the
 * recommendation is advisory ONLY (never auto-applied). Matching reports produce no finding.
 */
export function expenseReportTotalCheck(port: ReconciliationDataPort): AuditCheck {
  return {
    id: EXPENSE_REPORT_TOTAL_CHECK_ID,
    description:
      "Reconcile each expense report's declared total against the recomputed sum of its line items",
    blast: 'reversible',
    run: async (): Promise<{ findings: RawFinding[] }> => {
      const rows = await port.listExpenseReportTotals();
      const findings: RawFinding[] = [];
      for (const row of rows) {
        if (row.declaredTotalMinor === row.computedTotalMinor) continue; // reconciled — no finding
        findings.push({
          subjectRef: row.reportId,
          summary: `Expense report ${row.reportId} declared total disagrees with the sum of its line items`,
          expected: row.computedTotalMinor,
          observed: row.declaredTotalMinor,
          recommendation:
            `Re-derive expense report ${row.reportId}'s header total from its line items ` +
            `(computed ${row.computedTotalMinor} minor, declared ${row.declaredTotalMinor} minor); ` +
            'review before adjusting.',
        });
      }
      return { findings };
    },
  };
}

/** The stable check id for the unresolved-duplicate-invoice reconciliation. */
export const DUPLICATE_INVOICE_CHECK_ID = 'reconcile.duplicate-invoice';

/**
 * A vetted check: flag every invoice with an UNRESOLVED (`flagged`) duplicate record — a candidate
 * double-payment for a human to adjudicate (dismiss the flag or cancel the duplicate). blast
 * `reversible` (propose-only; no domain write). Every returned row is a finding.
 */
export function duplicateInvoiceCheck(port: ReconciliationDataPort): AuditCheck {
  return {
    id: DUPLICATE_INVOICE_CHECK_ID,
    description: 'Flag invoices carrying an unresolved (flagged) duplicate record for human review',
    blast: 'reversible',
    run: async (): Promise<{ findings: RawFinding[] }> => {
      const rows = await port.listUnresolvedDuplicateInvoices();
      return {
        findings: rows.map((row) => ({
          subjectRef: row.invoiceId,
          summary:
            `Invoice ${row.invoiceNumber} (${row.invoiceId}) is flagged as a potential duplicate` +
            (row.duplicateOf ? ` of ${row.duplicateOf}` : ''),
          expected: 'no unresolved duplicate flag',
          observed: `flagged duplicate (signature ${row.signature}, amount ${row.amountMinor} minor)`,
          recommendation:
            `Review invoice ${row.invoiceNumber}: confirm it is a duplicate (and cancel it) or dismiss ` +
            'the flag. Do not pay until resolved.',
        })),
      };
    },
  };
}

/** The stable check id for the orphaned-expense reconciliation. */
export const ORPHANED_EXPENSE_CHECK_ID = 'reconcile.orphaned-expense';

/**
 * A vetted check: flag every expense line item still attached to a SOFT-DELETED report — an orphaned
 * amount (referential-integrity drift). blast `reversible` (propose-only). Every returned row is a finding.
 */
export function orphanedExpenseCheck(port: ReconciliationDataPort): AuditCheck {
  return {
    id: ORPHANED_EXPENSE_CHECK_ID,
    description: 'Flag expense line items still attached to a soft-deleted report',
    blast: 'reversible',
    run: async (): Promise<{ findings: RawFinding[] }> => {
      const rows = await port.listOrphanedExpenses();
      return {
        findings: rows.map((row) => ({
          subjectRef: row.expenseId,
          summary: `Expense ${row.expenseId} is still attached to soft-deleted report ${row.reportId}`,
          expected: 'attached to a live report (or detached)',
          observed: `attached to soft-deleted report ${row.reportId} (amount ${row.amountMinor} minor)`,
          recommendation:
            `Reattach expense ${row.expenseId} to a live report or detach it; its report ` +
            `${row.reportId} is soft-deleted.`,
        })),
      };
    },
  };
}

/** Build the full, version-pinned list of reconciliation checks for a given data port. */
export function buildReconciliationChecks(port: ReconciliationDataPort): AuditCheck[] {
  return [
    expenseReportTotalCheck(port),
    duplicateInvoiceCheck(port),
    orphanedExpenseCheck(port),
  ];
}

/**
 * A V1-ONLY verifier. It NEVER consults a model — it simply reports that no independent judgment was
 * made. For NON-MATERIAL blasts (reversible/read) the Trust Rule accepts a single satisfied method, so
 * V1 (the deterministic recompute the SelfAuditCapability runs) alone verifies the proposal; V2 adds
 * nothing and is deliberately absent so the capability runs with NO model key. It is fail-closed by
 * construction: for a material blast, "V2 not satisfied" means the hardened AND cannot be met, so such
 * a finding correctly stays `needs_human`.
 */
class DeterministicOnlyVerifier implements IndependentVerifier {
  async verify(_req: VerificationRequest): Promise<VerificationVerdict> {
    return {
      verified: false,
      methods: [],
      reasons: [
        'deterministic-only reconciliation: no independent (V2) verifier configured — ' +
          'non-material blasts are satisfied by the V1 deterministic recompute alone',
      ],
    };
  }
}

/** Options for {@link runReconciliation}. */
export interface RunReconciliationOptions {
  /** The vetted checks to run (typically {@link buildReconciliationChecks}). */
  checks: AuditCheck[];
  /** The ONLY external effect: where finished proposals go (e.g. {@link appBrainProposalSink}). */
  proposalSink: ProposalSink;
  /**
   * Optional independent (V2) verifier. Defaults to a {@link DeterministicOnlyVerifier} so the run
   * needs NO model key — correct for the `reversible` reconciliation checks. Inject a
   * DualControlVerifier only if you also want an independent model judgment in the loop.
   */
  verifier?: IndependentVerifier;
  /**
   * The proposer model id passed through to the Trust Rule for independence reasoning. Irrelevant to
   * the deterministic-only default (no model runs), so it carries a sentinel value by default.
   */
  proposerModelId?: string;
}

/**
 * Thin wrapper that constructs a {@link SelfAuditCapability} with a V1-only verifier suitable for the
 * non-material reconciliation checks, runs the checks, and returns the {@link SelfAuditReport}. No
 * domain write happens anywhere in this path — the capability's sole side effect is the proposalSink.
 */
export function runReconciliation(opts: RunReconciliationOptions): Promise<SelfAuditReport> {
  const capability = new SelfAuditCapability({
    verifier: opts.verifier ?? new DeterministicOnlyVerifier(),
    proposerModelId: opts.proposerModelId ?? 'reconciliation-deterministic',
    proposalSink: opts.proposalSink,
  });
  return capability.run(opts.checks);
}

/**
 * A {@link ProposalSink} that maps each {@link AuditProposal} into a recallable app-brain memory via
 * {@link indexAuditProposal}, so verified reconciliation findings become part of the platform's own
 * memory ("what did the last reconcile flag about report X?"). This is a MEMORY write, not a domain
 * write — it stores a finding for a human, it never mutates the audited subject.
 */
export function appBrainProposalSink(service: AppBrainService): ProposalSink {
  return async (proposal: AuditProposal): Promise<void> => {
    await indexAuditProposal(service, {
      checkId: proposal.checkId,
      status: proposal.status,
      blast: proposal.blast,
      finding: proposal.finding,
    });
  };
}
