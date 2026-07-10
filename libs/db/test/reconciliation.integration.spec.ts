/**
 * INTEGRATION test for the RECONCILIATION capability against the LIVE Postgres. Mirrors
 * app-brain.integration.spec.ts: the app-brain service runs as the NON-OWNER `aegis_app` role so
 * Row-Level Security is genuinely enforced (DATABASE_URL points at aegis_app BEFORE @aegis/db is
 * imported). The OWNER (a superuser that bypasses RLS) seeds a tenant + scratch expense tables + a
 * DISCREPANT expense report and its line items; a raw-SQL {@link ReconciliationDataPort} reads those
 * live rows; {@link appBrainProposalSink} routes the verified finding into the app-brain; and we assert
 * the finding became a RECALLABLE `audit_finding` memory. No domain write ever happens — the capability
 * only reads and remembers.
 *
 * The scratch tables (`recon_expense_report`, `recon_expense_line_item`) are created + dropped by this
 * spec so it does not depend on any app's domain schema being migrated into this DB. It requires the
 * live compose Postgres with `app_brain_memory` present; it SKIPS (does not fail) if unreachable.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

// Point the shared connection at the NON-OWNER role before importing @aegis/db code.
process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { AppBrainService } from '../src/brain/app-brain.service';
import { getSequelize, closeSequelize } from '../src/connection';
import { withTenantTransaction } from '../src/transaction';
import {
  runReconciliation,
  buildReconciliationChecks,
  appBrainProposalSink,
  EXPENSE_REPORT_TOTAL_CHECK_ID,
  type ReconciliationDataPort,
} from '../../ai-core/src/autonomy/reconciliation';

const tenant = randomUUID();
const OK_REPORT = `rpt-ok-${randomUUID()}`;
const BAD_REPORT = `rpt-bad-${randomUUID()}`;

let owner: Sequelize;
let live = true;

async function ping(): Promise<boolean> {
  try {
    owner = new Sequelize(OWNER_URL, { dialect: 'postgres', logging: false });
    await owner.authenticate();
    const [{ ok }] = await owner.query<{ ok: boolean }>(
      `SELECT (to_regclass('public.app_brain_memory') IS NOT NULL) AS ok`,
      { type: QueryTypes.SELECT },
    );
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * A raw-SQL, RLS-scoped data port. It recomputes each report's total from its line items and pairs it
 * with the report's declared header total, exactly the shape {@link expenseReportTotalCheck} consumes.
 * It reads through the app connection (aegis_app), so it is subject to RLS just like the real thing.
 */
function sqlPort(): ReconciliationDataPort {
  return {
    async listExpenseReportTotals() {
      // Runs inside a tenant transaction (like every RLS-scoped read) so `app.current_tenant` is set
      // and the WHERE predicate resolves — the port is subject to the same tenant scoping as the real thing.
      const rows = await withTenantTransaction(
        (t) =>
          getSequelize().query<{
            report_id: string;
            declared_total_minor: string | number;
            computed_total_minor: string | number | null;
          }>(
            `SELECT r.id AS report_id,
                    r.declared_total_minor,
                    COALESCE(SUM(li.amount_minor), 0) AS computed_total_minor
               FROM recon_expense_report r
          LEFT JOIN recon_expense_line_item li ON li.report_id = r.id
              WHERE r.tenant_id = current_setting('app.current_tenant')::uuid
           GROUP BY r.id, r.declared_total_minor
           ORDER BY r.id`,
            { type: QueryTypes.SELECT, transaction: t },
          ),
        { tenantId: tenant },
      );
      return rows.map((row) => ({
        reportId: row.report_id,
        declaredTotalMinor: Number(row.declared_total_minor),
        computedTotalMinor: Number(row.computed_total_minor ?? 0),
      }));
    },
    // This spec exercises the expense-total check over scratch tables only; the other checks read no rows.
    async listUnresolvedDuplicateInvoices() {
      return [];
    },
    async listOrphanedExpenses() {
      return [];
    },
  };
}

beforeAll(async () => {
  live = await ping();
  if (!live) return;

  // Seed the tenant as OWNER (superuser bypasses RLS; the app role cannot create tenants).
  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1, 'Recon Tenant', $2, 'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenant, `recon-${tenant}`], type: QueryTypes.INSERT },
  );

  // Scratch expense schema (owned-schema so aegis_app can SELECT it; we scope reads by tenant in SQL).
  await owner.query(`
    CREATE TABLE IF NOT EXISTS recon_expense_report (
      id TEXT PRIMARY KEY,
      tenant_id UUID NOT NULL,
      declared_total_minor BIGINT NOT NULL
    )`);
  await owner.query(`
    CREATE TABLE IF NOT EXISTS recon_expense_line_item (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES recon_expense_report(id),
      amount_minor BIGINT NOT NULL
    )`);
  // The app role must be able to SELECT the scratch tables (owner created them; grant read).
  await owner.query(`GRANT SELECT ON recon_expense_report, recon_expense_line_item TO aegis_app`);

  // One RECONCILED report (declared 15000 = 10000 + 5000) and one DISCREPANT report
  // (declared 20000 but line items sum to 18500 = 12000 + 6500).
  await owner.query(
    `INSERT INTO recon_expense_report (id, tenant_id, declared_total_minor) VALUES
       ($1, $3, 15000), ($2, $3, 20000)`,
    { bind: [OK_REPORT, BAD_REPORT, tenant], type: QueryTypes.INSERT },
  );
  await owner.query(
    `INSERT INTO recon_expense_line_item (id, report_id, amount_minor) VALUES
       ($1, $2, 10000), ($3, $2, 5000),
       ($4, $5, 12000), ($6, $5, 6500)`,
    {
      bind: [
        `${OK_REPORT}-a`, OK_REPORT, `${OK_REPORT}-b`,
        `${BAD_REPORT}-a`, BAD_REPORT, `${BAD_REPORT}-b`,
      ],
      type: QueryTypes.INSERT,
    },
  );

  // eslint-disable-next-line no-console
  console.log('[reconciliation integration] seeded 1 reconciled + 1 discrepant report (LIVE DB)');
});

afterAll(async () => {
  if (live && owner) {
    await owner.query(`DELETE FROM app_brain_memory WHERE tenant_id = $1`, {
      bind: [tenant],
      type: QueryTypes.DELETE,
    });
    await owner.query(`DELETE FROM recon_expense_line_item WHERE report_id IN ($1, $2)`, {
      bind: [OK_REPORT, BAD_REPORT],
      type: QueryTypes.DELETE,
    });
    await owner.query(`DELETE FROM recon_expense_report WHERE id IN ($1, $2)`, {
      bind: [OK_REPORT, BAD_REPORT],
      type: QueryTypes.DELETE,
    });
    await owner.query(`DROP TABLE IF EXISTS recon_expense_line_item`);
    await owner.query(`DROP TABLE IF EXISTS recon_expense_report`);
    await owner.query(`DELETE FROM tenants WHERE id = $1`, {
      bind: [tenant],
      type: QueryTypes.DELETE,
    });
    await owner.close();
  }
  await closeSequelize();
});

describe('reconciliation (live Postgres, RLS as aegis_app) — verified finding becomes recallable memory', () => {
  it('runs the deterministic check over live rows and indexes ONLY the discrepant report', async () => {
    if (!live) return;

    const service = new AppBrainService({ tenantId: tenant });
    const report = await runReconciliation({
      checks: buildReconciliationChecks(sqlPort()),
      proposalSink: appBrainProposalSink(service),
    });

    // The reconciled report produced no finding; the discrepant one produced exactly one, and it
    // verified on the deterministic recompute alone (non-material `reversible` blast — no model key).
    expect(report.counts.total).toBe(1);
    expect(report.counts.verified).toBe(1);
    expect(report.proposals[0].status).toBe('verified_proposal');
    expect(report.proposals[0].finding.subjectRef).toBe(BAD_REPORT);
    expect(report.proposals[0].finding.expected).toBe(18500);
    expect(report.proposals[0].finding.observed).toBe(20000);
  });

  it('the finding is recallable from the app-brain (recall("reconcile") + kind=audit_finding)', async () => {
    if (!live) return;

    const service = new AppBrainService({ tenantId: tenant });

    // Semantic recall over the reconciliation content surfaces the finding.
    const hits = await service.recall('reconcile expense report total line items', 5);
    expect(hits.length).toBeGreaterThan(0);
    const byRef = hits.find((h) => h.ref === `${EXPENSE_REPORT_TOTAL_CHECK_ID}:${BAD_REPORT}`);
    expect(byRef).toBeDefined();
    expect(byRef?.kind).toBe('audit_finding');
    expect(byRef?.content).toContain('18500'); // the computed ground-truth total

    // A kind-filtered recall returns the audit_finding for the discrepant report (and none for the OK one).
    const findings = await service.recall('reconcile', 10, { kind: 'audit_finding' });
    const refs = findings.map((h) => h.ref);
    expect(refs).toContain(`${EXPENSE_REPORT_TOTAL_CHECK_ID}:${BAD_REPORT}`);
    expect(refs).not.toContain(`${EXPENSE_REPORT_TOTAL_CHECK_ID}:${OK_REPORT}`);
  });
});
