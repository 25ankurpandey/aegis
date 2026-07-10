/**
 * INTEGRATION test for the RECONCILIATION capability against the REAL domain schema (not the T28
 * scratch tables). It seeds genuine `expense_reports` / `expenses` / `invoices` / `invoice_duplicates`
 * rows with three planted discrepancies, drives the capability through the vetted RLS-scoped db queries
 * (`@aegis/db` reconciliation port), and asserts the three findings become recallable `audit_finding`
 * memories in the app-brain. Everything runs as the NON-OWNER `aegis_app` role (RLS enforced); NO
 * domain write ever happens — the capability only reads and remembers. Skips if the DB is unreachable.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { AppBrainService } from '../src/brain/app-brain.service';
import {
  listExpenseReportTotals,
  listUnresolvedDuplicateInvoices,
  listOrphanedExpenses,
} from '../src/reconciliation/queries';
import { closeSequelize } from '../src/connection';
import {
  runReconciliation,
  buildReconciliationChecks,
  appBrainProposalSink,
  EXPENSE_REPORT_TOTAL_CHECK_ID,
  DUPLICATE_INVOICE_CHECK_ID,
  ORPHANED_EXPENSE_CHECK_ID,
  type ReconciliationDataPort,
} from '../../ai-core/src/autonomy/reconciliation';

const tenant = randomUUID();
const R_DISCREPANT = randomUUID(); // total 20000 but line items sum 18500
const R_OK = randomUUID(); // reconciled
const R_DELETED = randomUUID(); // soft-deleted → its expense is orphaned
const E_ORPHAN = randomUUID();
const INV_ORIGINAL = randomUUID();
const INV_DUP = randomUUID();
const submitter = randomUUID();

let owner: Sequelize;
let live = true;

/** The real, RLS-scoped data port — the db queries pinned to this tenant (off the request path). */
const port: ReconciliationDataPort = {
  listExpenseReportTotals: () => listExpenseReportTotals({ tenantId: tenant }),
  listUnresolvedDuplicateInvoices: () => listUnresolvedDuplicateInvoices({ tenantId: tenant }),
  listOrphanedExpenses: () => listOrphanedExpenses({ tenantId: tenant }),
};

async function ping(): Promise<boolean> {
  try {
    owner = new Sequelize(OWNER_URL, { dialect: 'postgres', logging: false });
    await owner.authenticate();
    const [{ ok }] = await owner.query<{ ok: boolean }>(
      `SELECT (to_regclass('public.invoice_duplicates') IS NOT NULL
               AND to_regclass('public.app_brain_memory') IS NOT NULL) AS ok`,
      { type: QueryTypes.SELECT },
    );
    return ok === true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  live = await ping();
  if (!live) return;

  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1, 'Recon Live', $2, 'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenant, `reconlive-${tenant}`], type: QueryTypes.INSERT },
  );

  // Expense reports: one DISCREPANT (declared 20000 vs 18500), one RECONCILED (15000), one SOFT-DELETED.
  await owner.query(
    `INSERT INTO expense_reports (id, tenant_id, report_number, name, submitter_id, total_amount, deleted_at) VALUES
       ($1, $4, 1, 'Discrepant', $5, 20000, NULL),
       ($2, $4, 2, 'Reconciled', $5, 15000, NULL),
       ($3, $4, 3, 'Deleted',    $5,  4200, now())`,
    { bind: [R_DISCREPANT, R_OK, R_DELETED, tenant, submitter], type: QueryTypes.INSERT },
  );
  await owner.query(
    `INSERT INTO expenses (id, tenant_id, report_id, amount, created_by) VALUES
       ($1, $8, $2, 10000, $9), ($3, $8, $2, 8500, $9),        -- discrepant: 18500 ≠ 20000
       ($4, $8, $5, 10000, $9), ($6, $8, $5, 5000, $9),        -- reconciled: 15000 == 15000
       ($7, $8, $10, 4200, $9)`,                                //  orphan: attached to the deleted report
    {
      bind: [
        randomUUID(), R_DISCREPANT, randomUUID(),
        randomUUID(), R_OK, randomUUID(),
        E_ORPHAN, tenant, submitter, R_DELETED,
      ],
      type: QueryTypes.INSERT,
    },
  );

  // Invoices: an original + a duplicate, with an UNRESOLVED (flagged) duplicate record.
  await owner.query(
    `INSERT INTO invoices (id, tenant_id, vendor_name, invoice_number, invoice_date, amount_minor, currency) VALUES
       ($1, $3, 'Acme', 'INV-ORIG', DATE '2026-01-01', 9900, 'USD'),
       ($2, $3, 'Acme', 'INV-DUP',  DATE '2026-01-02', 9900, 'USD')`,
    { bind: [INV_ORIGINAL, INV_DUP, tenant], type: QueryTypes.INSERT },
  );
  await owner.query(
    `INSERT INTO invoice_duplicates (tenant_id, invoice_id, duplicate_of, signature, status) VALUES
       ($1, $2, $3, 'acme|9900|usd', 'flagged')`,
    { bind: [tenant, INV_DUP, INV_ORIGINAL], type: QueryTypes.INSERT },
  );

  // eslint-disable-next-line no-console
  console.log('[reconciliation-live] seeded 3 planted discrepancies (expense-total, duplicate, orphan)');
});

afterAll(async () => {
  if (live && owner) {
    await owner.query(`DELETE FROM app_brain_memory WHERE tenant_id = $1`, { bind: [tenant], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM invoice_duplicates WHERE tenant_id = $1`, { bind: [tenant], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM invoices WHERE tenant_id = $1`, { bind: [tenant], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM expenses WHERE tenant_id = $1`, { bind: [tenant], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM expense_reports WHERE tenant_id = $1`, { bind: [tenant], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM tenants WHERE id = $1`, { bind: [tenant], type: QueryTypes.DELETE });
    await owner.close();
  }
  await closeSequelize();
});

describe('reconciliation (live Postgres, REAL schema, RLS as aegis_app)', () => {
  it('the RLS-scoped db queries recompute the planted discrepancies correctly', async () => {
    if (!live) return;
    const totals = await listExpenseReportTotals({ tenantId: tenant });
    expect(totals.find((r) => r.reportId === R_DISCREPANT)).toMatchObject({ declaredTotalMinor: 20000, computedTotalMinor: 18500 });
    expect(totals.find((r) => r.reportId === R_OK)).toMatchObject({ declaredTotalMinor: 15000, computedTotalMinor: 15000 });
    // The soft-deleted report is excluded from the total check entirely.
    expect(totals.find((r) => r.reportId === R_DELETED)).toBeUndefined();

    const dups = await listUnresolvedDuplicateInvoices({ tenantId: tenant });
    expect(dups.map((d) => d.invoiceId)).toEqual([INV_DUP]);

    const orphans = await listOrphanedExpenses({ tenantId: tenant });
    expect(orphans.map((o) => o.expenseId)).toEqual([E_ORPHAN]);
  });

  it('runReconciliation flags exactly the three planted discrepancies and indexes them into the app-brain', async () => {
    if (!live) return;
    const service = new AppBrainService({ tenantId: tenant });
    const report = await runReconciliation({
      checks: buildReconciliationChecks(port),
      proposalSink: appBrainProposalSink(service),
    });

    expect(report.counts.total).toBe(3);
    expect(report.counts.verified).toBe(3); // all reversible ⇒ V1 verifies, no model key
    const refs = report.proposals.map((p) => `${p.checkId}:${p.finding.subjectRef}`).sort();
    expect(refs).toEqual(
      [
        `${DUPLICATE_INVOICE_CHECK_ID}:${INV_DUP}`,
        `${EXPENSE_REPORT_TOTAL_CHECK_ID}:${R_DISCREPANT}`,
        `${ORPHANED_EXPENSE_CHECK_ID}:${E_ORPHAN}`,
      ].sort(),
    );
  });

  it('the findings are recallable from the app-brain (kind=audit_finding)', async () => {
    if (!live) return;
    const service = new AppBrainService({ tenantId: tenant });
    const findings = await service.recall('reconcile expense invoice report', 20, { kind: 'audit_finding' });
    const refs = findings.map((h) => h.ref);
    expect(refs).toContain(`${EXPENSE_REPORT_TOTAL_CHECK_ID}:${R_DISCREPANT}`);
    expect(refs).toContain(`${DUPLICATE_INVOICE_CHECK_ID}:${INV_DUP}`);
    expect(refs).toContain(`${ORPHANED_EXPENSE_CHECK_ID}:${E_ORPHAN}`);
    // The reconciled report never produced a finding, so it is not in memory.
    expect(refs).not.toContain(`${EXPENSE_REPORT_TOTAL_CHECK_ID}:${R_OK}`);
  });
});
