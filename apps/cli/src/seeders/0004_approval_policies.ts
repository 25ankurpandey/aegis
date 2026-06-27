import { type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { randomUUID as uuid } from 'node:crypto';
import {
  TableName,
  ApprovalMode,
  ApprovalRecordType,
  ApproverSource,
  ApproverType,
  SystemRole,
} from '@aegis/shared-enums';
import type { ApprovalShape } from '@aegis/shared-types';

/**
 * SHARED default approval policies for the demo tenant — ONE seeder covering EVERY approvable record
 * type (expense reports, invoices, pay runs) so invoice/payroll do NOT each add their own. After
 * dev-up, submitting any of the three routes through the shared `@aegis/approvals` engine instead of
 * the legacy single-shot inline approval.
 *
 * Each policy is keyed by `(tenant_id, record_type)`; the engine reads `mode` + `min_approvals` +
 * `config.levels` to resolve a chain. Design of the defaults (sensible, not exhaustive):
 *
 *  - ExpenseReport — SEQUENTIAL. L1 = the requester's reporting MANAGER (W3-05, `source: manager`,
 *    resolves to a concrete user the manager can act as). L2 = a SENIOR tier gated by an amount
 *    threshold (>= $1,000.00 = 100_000 minor units in USD) routed to the `approver` role — only large
 *    reports pick up the second gate (W3-03 amount-threshold). A report under the threshold clears on
 *    the manager alone.
 *  - Invoice — SEQUENTIAL, single MANAGER level (manager-or-role; the simplest one-gate chain).
 *  - PayRun — SEQUENTIAL, single MANAGER level with SoD `excludeRequester: true` (W3 separation of
 *    duties: whoever queued the pay run can never approve it).
 *
 * NOTE on manager resolution: `source: manager` resolves against the tenant's `approval_hierarchy`
 * edges. A tenant with no hierarchy edges yet resolves an empty manager level — the engine then
 * auto-completes that record as approved (no required approver), which is the correct "unconfigured
 * org chart" behaviour. Seed `approval_hierarchy` (or switch a level to `source: group`/`user`) to
 * make the chain land on a concrete approver in the demo.
 */

const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';

/** A single manager-sourced level (resolves to the requester's reporting manager, W3-05). */
function managerLevel(level: number): ApprovalShape.PolicyLevelSpec {
  return { level, source: ApproverSource.Manager, approver_type: ApproverType.User };
}

/** Build the policy rows for the demo tenant — one per approvable record type. */
function demoPolicies(now: Date): Array<Record<string, unknown>> {
  const base = {
    tenant_id: DEMO_TENANT_ID,
    is_active: true,
    created_at: now,
    updated_at: now,
  };

  const expenseConfig: ApprovalShape.PolicyConfig = {
    levels: [
      managerLevel(1),
      // Senior tier: only for large reports (>= 100_000 minor units = $1,000.00), routed to the
      // approver role. Amount-threshold gate means small reports never pick up this level (W3-03).
      {
        level: 2,
        source: ApproverSource.Role,
        approver_type: ApproverType.Role,
        approver_id: SystemRole.Approver,
        amountMinorMin: 100_000,
        currency: 'USD',
      },
    ],
  };

  const invoiceConfig: ApprovalShape.PolicyConfig = {
    levels: [managerLevel(1)],
  };

  const payRunConfig: ApprovalShape.PolicyConfig = {
    // SoD: whoever queued the pay run can never approve it (separation of duties).
    excludeRequester: true,
    levels: [managerLevel(1)],
  };

  return [
    {
      ...base,
      id: uuid(),
      record_type: ApprovalRecordType.ExpenseReport,
      name: 'default',
      mode: ApprovalMode.Sequential,
      min_approvals: 1,
      config: JSON.stringify(expenseConfig),
    },
    {
      ...base,
      id: uuid(),
      record_type: ApprovalRecordType.Invoice,
      name: 'default',
      mode: ApprovalMode.Sequential,
      min_approvals: 1,
      config: JSON.stringify(invoiceConfig),
    },
    {
      ...base,
      id: uuid(),
      record_type: ApprovalRecordType.PayRun,
      name: 'default',
      mode: ApprovalMode.Sequential,
      min_approvals: 1,
      config: JSON.stringify(payRunConfig),
    },
  ];
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const now = new Date();
  // Set the tenant context so RLS WITH CHECK accepts the tenant-scoped inserts.
  await q.sequelize.query(`SELECT set_config('app.current_tenant', '${DEMO_TENANT_ID}', false)`);

  await q.bulkInsert(TableName.ApprovalPolicies, demoPolicies(now));
  console.log(
    `[seed] default approval policies for demo tenant ${DEMO_TENANT_ID}: ` +
      `${ApprovalRecordType.ExpenseReport}, ${ApprovalRecordType.Invoice}, ${ApprovalRecordType.PayRun}`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`SELECT set_config('app.current_tenant', '${DEMO_TENANT_ID}', false)`);
  await q.bulkDelete(TableName.ApprovalPolicies, {
    tenant_id: DEMO_TENANT_ID,
    name: 'default',
  });
}
