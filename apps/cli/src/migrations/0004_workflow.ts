import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName, RuleEvent, RuleActionType, RuleRunStatus } from '@aegis/shared-enums';
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
const ruleFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Rules, key: 'id' },
  onDelete: 'CASCADE',
};
// Audit attribution (donor parity: created_by/updated_by on mutable entities).
const auditCols = {
  created_by: { type: DataTypes.UUID, allowNull: true },
  updated_by: { type: DataTypes.UUID, allowNull: true },
};

// CHECK helpers — render an enum object's values into a SQL `IN (...)` membership clause.
const sqlList = (vals: readonly string[]): string => vals.map((v) => `'${v}'`).join(', ');
const inSet = (col: string, e: Record<string, string>): string =>
  `"${col}" IN (${sqlList(Object.values(e))})`;

/**
 * workflow — rules-as-data engine. Four tenant-scoped tables, each with tenant_id NOT NULL and
 * FORCE/RESTRICTIVE Row-Level Security on tenant_id. rule_audit_logs is append-only (no updated_at,
 * no audit/soft-delete columns). Enum-backed columns carry CHECK constraints; the rule aggregate
 * root carries created_by/updated_by audit attribution + a deleted_at soft-delete column.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // rules — aggregate root (long-lived master entity → audit + soft-delete).
  await q.createTable(TableName.Rules, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    event: { type: DataTypes.STRING, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_run: { type: DataTypes.DATE, allowNull: true },
    ...auditCols,
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    // Optimistic-lock counter (Sequelize `version: 'lock_version'`): concurrent rule edits get an
    // OptimisticLockError instead of a silent lost update.
    lock_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps,
  });
  await q.addIndex(TableName.Rules, ['tenant_id', 'event', 'active'], { name: 'rules_tenant_event_active_idx' });
  // Listing path (repository orders by created_at DESC, tenant-scoped).
  await q.addIndex(TableName.Rules, ['tenant_id', 'created_at'], { name: 'rules_tenant_created_idx' });
  // A rule name is a tenant-unique natural key (ignoring soft-deleted rows).
  await q.addIndex(TableName.Rules, ['tenant_id', 'name'], {
    name: 'rules_tenant_name_uq',
    unique: true,
    where: { deleted_at: null },
  });
  await q.addConstraint(TableName.Rules, {
    type: 'check',
    fields: ['event'],
    name: 'rules_event_check',
    where: Sequelize.literal(inSet('event', RuleEvent)),
  });

  // rule_steps — mutable child config (audit attribution; no soft-delete — rebuilt with the rule).
  await q.createTable(TableName.RuleSteps, {
    id: uuidPk,
    tenant_id: tenantFk,
    rule_id: ruleFk,
    order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    query: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    ...auditCols,
    ...timestamps,
  });
  await q.addIndex(TableName.RuleSteps, ['tenant_id', 'rule_id'], { name: 'rule_steps_tenant_rule_idx' });
  await q.addConstraint(TableName.RuleSteps, {
    type: 'check',
    fields: ['order'],
    name: 'rule_steps_order_nonneg_check',
    where: Sequelize.literal('"order" >= 0'),
  });

  // rule_actions — mutable child config (audit attribution; no soft-delete — rebuilt with the rule).
  await q.createTable(TableName.RuleActions, {
    id: uuidPk,
    tenant_id: tenantFk,
    rule_id: ruleFk,
    type: { type: DataTypes.STRING, allowNull: false },
    config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    ...auditCols,
    ...timestamps,
  });
  await q.addIndex(TableName.RuleActions, ['tenant_id', 'rule_id'], { name: 'rule_actions_tenant_rule_idx' });
  await q.addConstraint(TableName.RuleActions, {
    type: 'check',
    fields: ['type'],
    name: 'rule_actions_type_check',
    where: Sequelize.literal(inSet('type', RuleActionType)),
  });

  // rule_audit_logs — append-only verdict log (created_at only; no audit cols, no soft-delete).
  await q.createTable(TableName.RuleAuditLogs, {
    id: uuidPk,
    tenant_id: tenantFk,
    rule_id: ruleFk,
    status: { type: DataTypes.STRING, allowNull: false },
    detail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    // append-only: created_at only, no updated_at
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  });
  await q.addIndex(TableName.RuleAuditLogs, ['tenant_id', 'rule_id'], { name: 'rule_audit_logs_tenant_rule_idx' });
  // Chronological queries of the verdict log (tenant-scoped).
  await q.addIndex(TableName.RuleAuditLogs, ['tenant_id', 'created_at'], { name: 'rule_audit_logs_tenant_created_idx' });
  await q.addConstraint(TableName.RuleAuditLogs, {
    type: 'check',
    fields: ['status'],
    name: 'rule_audit_logs_status_check',
    where: Sequelize.literal(inSet('status', RuleRunStatus)),
  });

  // Row-Level Security — FORCE + RESTRICTIVE tenant isolation on every table.
  const stmts = [
    ...rlsPolicyStatements(TableName.Rules),
    ...rlsPolicyStatements(TableName.RuleSteps),
    ...rlsPolicyStatements(TableName.RuleActions),
    ...rlsPolicyStatements(TableName.RuleAuditLogs),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.RuleAuditLogs);
  await q.dropTable(TableName.RuleActions);
  await q.dropTable(TableName.RuleSteps);
  await q.dropTable(TableName.Rules);
}
