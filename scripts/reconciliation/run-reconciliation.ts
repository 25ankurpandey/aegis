/**
 * RUN RECONCILIATION for a tenant — the runner for the propose-only reconciliation autonomous
 * capability. It wires the vetted, RLS-scoped `@aegis/db` reconciliation queries into the capability's
 * data port, runs every check, routes each verified finding into the tenant's app-brain as a recallable
 * `audit_finding` memory, and prints a summary. It NEVER writes to the domain — it reads and remembers.
 *
 * The capability is LLM-FREE: reconciliation checks are deterministic + propose-only (non-material), so
 * the V1 deterministic recompute alone verifies each finding (no model key needed).
 *
 * Run (against the local compose DB, as the non-owner app role so RLS is enforced):
 *   DATABASE_URL='postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis' \
 *   TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
 *     node -r ts-node/register -r tsconfig-paths/register scripts/reconciliation/run-reconciliation.ts <tenantId>
 */
import {
  AppBrainService,
  listExpenseReportTotals,
  listUnresolvedDuplicateInvoices,
  listOrphanedExpenses,
  closeSequelize,
} from '@aegis/db';
import {
  runReconciliation,
  buildReconciliationChecks,
  appBrainProposalSink,
  type ReconciliationDataPort,
} from '@aegis/ai-core';

async function main(): Promise<void> {
  const tenantId = process.argv[2] ?? process.env.AEGIS_TENANT_ID;
  if (!tenantId) {
    process.stderr.write('usage: run-reconciliation.ts <tenantId>  (or set AEGIS_TENANT_ID)\n');
    process.exit(2);
  }

  // Adapt the RLS-scoped db queries into the capability's data port (pinned to this tenant).
  const port: ReconciliationDataPort = {
    listExpenseReportTotals: () => listExpenseReportTotals({ tenantId }),
    listUnresolvedDuplicateInvoices: () => listUnresolvedDuplicateInvoices({ tenantId }),
    listOrphanedExpenses: () => listOrphanedExpenses({ tenantId }),
  };

  const service = new AppBrainService({ tenantId });
  const report = await runReconciliation({
    checks: buildReconciliationChecks(port),
    proposalSink: appBrainProposalSink(service),
  });

  process.stdout.write(`\nRECONCILIATION for tenant ${tenantId}\n`);
  process.stdout.write(
    `  findings: ${report.counts.total} (${report.counts.verified} verified, ${report.counts.needsHuman} need a human)\n`,
  );
  for (const [checkId, n] of Object.entries(report.ranByCheck)) {
    process.stdout.write(`  ${checkId}: ${n} finding(s)\n`);
  }
  for (const p of report.proposals) {
    process.stdout.write(`  - [${p.status}] ${p.checkId} :: ${p.finding.summary}\n`);
  }
  process.stdout.write('\nAll findings were indexed into the app-brain (kind=audit_finding) for recall.\n\n');

  await closeSequelize();
}

main().catch((err) => {
  process.stderr.write(`reconciliation run failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
