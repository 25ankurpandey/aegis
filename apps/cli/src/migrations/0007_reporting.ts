import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName, ReportRunStatus } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};
const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
};
const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};
// Nullable actor columns — who created / last mutated the row (system writes leave them null).
const createdBy = { type: DataTypes.UUID, allowNull: true };
const updatedBy = { type: DataTypes.UUID, allowNull: true };
// Paranoid soft-delete tombstone for long-lived master entities (null = live row).
const deletedAt = { type: DataTypes.DATE, allowNull: true };

// The closed status set for an asynchronous report run (CQRS read-side run lifecycle).
const REPORT_RUN_STATUSES = Object.values(ReportRunStatus);

/**
 * reporting (CQRS-lite read side) control plane: declarative definitions, schedules, asynchronous
 * runs, and per-role column/row access policies. Reporting is the highest-leakage surface in the
 * platform, so EVERY table here is tenant-scoped (tenant_id NOT NULL) and RLS-guarded with a
 * FORCE + RESTRICTIVE tenant-isolation policy — RLS is never bypassed.
 *
 * Donor-grade integrity (all additive — no existing column is renamed/removed):
 *  - CHECK constraints pin the run status to its allowed value set and assert temporal sanity.
 *  - Mutable entities carry created_by/updated_by (run log keeps only requested_by — it is append-once).
 *  - report_definitions is a long-lived master entity → paranoid soft-delete (deleted_at); the run
 *    log is NEVER soft-deleted (it is an immutable record of what executed).
 *  - Composite (tenant_id, created_at) listing indexes + a unique natural key on (tenant_id, role).
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TableName.ReportDefinitions, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    // { measures[], dimensions[], filters[], grain, source } — declarative, compiled (never raw SQL)
    spec: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    required_permission: { type: DataTypes.STRING, allowNull: false },
    created_by: { type: DataTypes.UUID, allowNull: false },
    // Audit: last mutator (nullable — null until the row is first updated). Soft-delete tombstone.
    updated_by: updatedBy,
    deleted_at: deletedAt,
    ...timestamps,
  });
  await q.addIndex(TableName.ReportDefinitions, ['tenant_id', 'name'], {
    name: 'report_definitions_tenant_name_idx',
  });
  // Listing order is (tenant_id, created_at DESC) in the repository — back it with an index.
  await q.addIndex(TableName.ReportDefinitions, ['tenant_id', 'created_at'], {
    name: 'report_definitions_tenant_created_idx',
  });

  await q.createTable(TableName.ReportSchedules, {
    id: uuidPk,
    tenant_id: tenantFk,
    definition_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.ReportDefinitions, key: 'id' },
      onDelete: 'CASCADE',
    },
    cron: { type: DataTypes.STRING, allowNull: false },
    timezone: { type: DataTypes.STRING, allowNull: false, defaultValue: 'UTC' },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // Audit columns — schedules are mutable configuration.
    created_by: createdBy,
    updated_by: updatedBy,
    ...timestamps,
  });
  await q.addIndex(TableName.ReportSchedules, ['tenant_id', 'definition_id'], {
    name: 'report_schedules_tenant_definition_idx',
  });

  await q.createTable(TableName.ReportRuns, {
    id: uuidPk,
    tenant_id: tenantFk,
    definition_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.ReportDefinitions, key: 'id' },
      onDelete: 'CASCADE',
    },
    requested_by: { type: DataTypes.UUID, allowNull: false },
    params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    // queued | running | succeeded | failed (plain strings) — pinned by a CHECK constraint below.
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'queued' },
    started_at: { type: DataTypes.DATE, allowNull: true },
    finished_at: { type: DataTypes.DATE, allowNull: true },
    artifact_url: { type: DataTypes.TEXT, allowNull: true },
    error: { type: DataTypes.TEXT, allowNull: true },
    // NOTE: report_runs is an append-once run LOG — no created_by/updated_by, no soft-delete.
    ...timestamps,
  });
  await q.addIndex(TableName.ReportRuns, ['tenant_id', 'definition_id'], {
    name: 'report_runs_tenant_definition_idx',
  });
  await q.addIndex(TableName.ReportRuns, ['tenant_id', 'status'], {
    name: 'report_runs_tenant_status_idx',
  });
  // Recent-runs listing / time-window queries are (tenant_id, created_at) shaped.
  await q.addIndex(TableName.ReportRuns, ['tenant_id', 'created_at'], {
    name: 'report_runs_tenant_created_idx',
  });
  // Constrain status to its closed set so a bad write can never persist an unknown state.
  await q.addConstraint(TableName.ReportRuns, {
    type: 'check',
    fields: ['status'],
    name: 'report_runs_status_chk',
    where: { status: [...REPORT_RUN_STATUSES] },
  });
  // Temporal sanity: a run cannot finish before it started.
  await q.sequelize.query(
    `ALTER TABLE "${TableName.ReportRuns}" ADD CONSTRAINT "report_runs_finished_after_started_chk" ` +
      `CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at);`,
  );

  await q.createTable(TableName.ReportAccessPolicies, {
    id: uuidPk,
    tenant_id: tenantFk,
    role: { type: DataTypes.STRING, allowNull: false },
    // column-masking obligation inputs (§5.2) + row-level scope predicate (§5.1)
    allowed_columns: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    masked_columns: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    row_filter: { type: DataTypes.TEXT, allowNull: true },
    // Audit columns — access policies are mutable configuration.
    created_by: createdBy,
    updated_by: updatedBy,
    ...timestamps,
  });
  // (tenant_id, role) is the natural/idempotency key — one policy per role per tenant.
  await q.addIndex(TableName.ReportAccessPolicies, ['tenant_id', 'role'], {
    unique: true,
    name: 'report_access_policies_tenant_role_uq',
  });

  // Row-Level Security — FORCE + RESTRICTIVE tenant isolation on every reporting table.
  const stmts = [
    ...rlsPolicyStatements(TableName.ReportDefinitions),
    ...rlsPolicyStatements(TableName.ReportSchedules),
    ...rlsPolicyStatements(TableName.ReportRuns),
    ...rlsPolicyStatements(TableName.ReportAccessPolicies),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.ReportAccessPolicies);
  await q.dropTable(TableName.ReportRuns);
  await q.dropTable(TableName.ReportSchedules);
  await q.dropTable(TableName.ReportDefinitions);
}
