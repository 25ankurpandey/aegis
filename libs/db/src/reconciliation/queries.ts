import { QueryTypes } from 'sequelize';
import { getSequelize } from '../connection';
import { withTenantTransaction } from '../transaction';

/**
 * @aegis/db / reconciliation — the DETERMINISTIC, RLS-scoped read queries behind the reconciliation
 * autonomous capability. These are vetted, human-authored recompute queries (the LLM never authors
 * them): each recomputes a ground truth from the live domain tables so the capability can flag
 * discrepancies as PROPOSALS. Every query runs inside {@link withTenantTransaction}, so it only ever
 * sees the caller's tenant (Postgres RLS) — no cross-tenant leakage.
 *
 * This module has NO `@aegis/ai-core` dependency (it returns plain data shapes); the capability's
 * `ReconciliationDataPort` is satisfied by adapting these functions at the wiring site (runner/test),
 * which keeps the lib dependency direction one-way (ai-core → db).
 */

/** Options common to every reconciliation query: pin the tenant explicitly (off-request callers). */
export interface ReconQueryOptions {
  tenantId?: string;
  userId?: string;
}

/** One expense report's declared header total paired with the total recomputed from its line items. */
export interface ExpenseReportTotalRow {
  reportId: string;
  declaredTotalMinor: number;
  computedTotalMinor: number;
}

/** An invoice with an unresolved (`flagged`) duplicate record awaiting a human's review. */
export interface UnresolvedDuplicateInvoiceRow {
  invoiceId: string;
  duplicateOf: string | null;
  invoiceNumber: string;
  amountMinor: number;
  signature: string;
}

/** An expense line item still attached to a report that has been soft-deleted (`deleted_at` set). */
export interface OrphanedExpenseRow {
  expenseId: string;
  reportId: string;
  amountMinor: number;
}

/**
 * Every LIVE expense report with its declared `total_amount` and the sum recomputed from its line
 * items (the ground truth). A discrepancy = a report whose declared total ≠ the computed sum.
 */
export function listExpenseReportTotals(opts: ReconQueryOptions = {}): Promise<ExpenseReportTotalRow[]> {
  return withTenantTransaction(async (t) => {
    const rows = await getSequelize().query<{
      report_id: string;
      declared_total_minor: string | number;
      computed_total_minor: string | number | null;
    }>(
      `SELECT r.id AS report_id,
              r.total_amount AS declared_total_minor,
              COALESCE(SUM(e.amount), 0) AS computed_total_minor
         FROM expense_reports r
    LEFT JOIN expenses e ON e.report_id = r.id
        WHERE r.deleted_at IS NULL
     GROUP BY r.id, r.total_amount
     ORDER BY r.id`,
      { type: QueryTypes.SELECT, transaction: t },
    );
    return rows.map((row) => ({
      reportId: row.report_id,
      declaredTotalMinor: Number(row.declared_total_minor),
      computedTotalMinor: Number(row.computed_total_minor ?? 0),
    }));
  }, opts);
}

/** Invoices carrying an unresolved (`flagged`) duplicate record — candidates for a human to adjudicate. */
export function listUnresolvedDuplicateInvoices(
  opts: ReconQueryOptions = {},
): Promise<UnresolvedDuplicateInvoiceRow[]> {
  return withTenantTransaction(async (t) => {
    const rows = await getSequelize().query<{
      invoice_id: string;
      duplicate_of: string | null;
      signature: string;
      invoice_number: string;
      amount_minor: string | number;
    }>(
      `SELECT d.invoice_id, d.duplicate_of, d.signature, i.invoice_number, i.amount_minor
         FROM invoice_duplicates d
         JOIN invoices i ON i.id = d.invoice_id
        WHERE d.status = 'flagged' AND i.deleted_at IS NULL
     ORDER BY d.invoice_id`,
      { type: QueryTypes.SELECT, transaction: t },
    );
    return rows.map((row) => ({
      invoiceId: row.invoice_id,
      duplicateOf: row.duplicate_of,
      invoiceNumber: row.invoice_number,
      amountMinor: Number(row.amount_minor),
      signature: row.signature,
    }));
  }, opts);
}

/** Expense line items still attached to a soft-deleted report (referential-integrity drift). */
export function listOrphanedExpenses(opts: ReconQueryOptions = {}): Promise<OrphanedExpenseRow[]> {
  return withTenantTransaction(async (t) => {
    const rows = await getSequelize().query<{
      expense_id: string;
      report_id: string;
      amount_minor: string | number;
    }>(
      `SELECT e.id AS expense_id, e.report_id, e.amount AS amount_minor
         FROM expenses e
         JOIN expense_reports r ON r.id = e.report_id
        WHERE e.report_id IS NOT NULL AND r.deleted_at IS NOT NULL
     ORDER BY e.id`,
      { type: QueryTypes.SELECT, transaction: t },
    );
    return rows.map((row) => ({
      expenseId: row.expense_id,
      reportId: row.report_id,
      amountMinor: Number(row.amount_minor),
    }));
  }, opts);
}
