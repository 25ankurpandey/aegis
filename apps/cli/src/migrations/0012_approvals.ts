import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import {
  ApprovalMode,
  ApproverType,
  ApprovalDecision,
  RecordApproverStatus,
  ApproverGroupMemberType,
} from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * The shared multi-level approval engine (`@aegis/approvals`) — six tables that replace the three
 * independent single-shot inline approvals (expense / invoice / payroll) with ONE configurable,
 * tenant-scoped, multi-level, hierarchy-aware engine keyed by a polymorphic `(record_type, record_id)`.
 * See docs/analysis/B1-approvals.md and SPEC §11.
 *
 * Every table is tenant-scoped with FORCE + RESTRICTIVE Row-Level Security keyed on app.current_tenant
 * (so an approval row can never leak across tenants), has created_at/updated_at, created_by/updated_by
 * on mutable aggregates, CHECK constraints pinning every enum column to its allowed values, partial
 * UNIQUE indexes (`WHERE deleted_at IS NULL`) on natural keys for the soft-deleted aggregates, and
 * composite `(tenant_id, status)` / `(tenant_id, created_at)` indexes for the common access paths.
 */

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
const auditCols = {
  created_by: { type: DataTypes.UUID, allowNull: true },
  updated_by: { type: DataTypes.UUID, allowNull: true },
};
const softDelete = { deleted_at: { type: DataTypes.DATE, allowNull: true } };

/** `ADD CONSTRAINT ... CHECK (col IN (...))` pinning an enum column to its allowed values. */
function enumCheck(table: string, column: string, values: readonly string[]): string {
  const list = values.map((v) => `'${v}'`).join(', ');
  return `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${column}_check" CHECK ("${column}" IN (${list}))`;
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // ---- approval_policies — how a record TYPE is approved for one tenant (soft-delete) ----
  await q.createTable(TableName.ApprovalPolicies, {
    id: uuidPk,
    tenant_id: tenantFk,
    record_type: { type: DataTypes.STRING, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    mode: { type: DataTypes.STRING, allowNull: false, defaultValue: ApprovalMode.Sequential },
    min_approvals: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    ...auditCols,
    ...timestamps,
    ...softDelete,
  });
  // One active policy per (tenant, record_type, name) among live rows.
  await q.addIndex(TableName.ApprovalPolicies, ['tenant_id', 'record_type', 'name'], {
    unique: true,
    name: 'approval_policies_tenant_type_name_uq',
    where: { deleted_at: null },
  });
  await q.addIndex(TableName.ApprovalPolicies, ['tenant_id', 'record_type'], {
    name: 'approval_policies_tenant_type_idx',
  });
  await q.addIndex(TableName.ApprovalPolicies, ['tenant_id', 'created_at'], {
    name: 'approval_policies_tenant_created_idx',
  });
  await q.sequelize.query(
    enumCheck(TableName.ApprovalPolicies, 'mode', Object.values(ApprovalMode)),
  );
  await q.sequelize.query(
    `ALTER TABLE "${TableName.ApprovalPolicies}" ADD CONSTRAINT "approval_policies_min_approvals_check" CHECK ("min_approvals" >= 1)`,
  );

  // ---- approval_hierarchy — tenant manager/reporting hierarchy (manager-based resolution) ----
  await q.createTable(TableName.ApprovalHierarchy, {
    id: uuidPk,
    tenant_id: tenantFk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    manager_id: { type: DataTypes.UUID, allowNull: true },
    depth: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps,
  });
  // One hierarchy edge per (tenant, user).
  await q.addIndex(TableName.ApprovalHierarchy, ['tenant_id', 'user_id'], {
    unique: true,
    name: 'approval_hierarchy_tenant_user_uq',
  });
  await q.addIndex(TableName.ApprovalHierarchy, ['tenant_id', 'manager_id'], {
    name: 'approval_hierarchy_tenant_manager_idx',
  });
  await q.sequelize.query(
    `ALTER TABLE "${TableName.ApprovalHierarchy}" ADD CONSTRAINT "approval_hierarchy_depth_check" CHECK ("depth" >= 0)`,
  );

  // ---- approver_groups — named approver groups (soft-delete) ----
  await q.createTable(TableName.ApproverGroups, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...auditCols,
    ...timestamps,
    ...softDelete,
  });
  await q.addIndex(TableName.ApproverGroups, ['tenant_id', 'name'], {
    unique: true,
    name: 'approver_groups_tenant_name_uq',
    where: { deleted_at: null },
  });
  await q.addIndex(TableName.ApproverGroups, ['tenant_id', 'created_at'], {
    name: 'approver_groups_tenant_created_idx',
  });

  // ---- approver_group_members — polymorphic membership (user | role) ----
  await q.createTable(TableName.ApproverGroupMembers, {
    id: uuidPk,
    tenant_id: tenantFk,
    group_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.ApproverGroups, key: 'id' },
      onDelete: 'CASCADE',
    },
    member_type: { type: DataTypes.STRING, allowNull: false },
    member_id: { type: DataTypes.UUID, allowNull: false },
    ...timestamps,
  });
  // A principal appears at most once per group (per kind).
  await q.addIndex(TableName.ApproverGroupMembers, ['tenant_id', 'group_id', 'member_type', 'member_id'], {
    unique: true,
    name: 'approver_group_members_group_member_uq',
  });
  await q.addIndex(TableName.ApproverGroupMembers, ['tenant_id', 'group_id'], {
    name: 'approver_group_members_group_idx',
  });
  await q.sequelize.query(
    enumCheck(TableName.ApproverGroupMembers, 'member_type', Object.values(ApproverGroupMemberType)),
  );

  // ---- record_approvers — the resolved approver chain for one record instance ----
  await q.createTable(TableName.RecordApprovers, {
    id: uuidPk,
    tenant_id: tenantFk,
    record_type: { type: DataTypes.STRING, allowNull: false },
    record_id: { type: DataTypes.UUID, allowNull: false },
    level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    approver_type: { type: DataTypes.STRING, allowNull: false, defaultValue: ApproverType.User },
    approver_id: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: RecordApproverStatus.Pending },
    sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    ...timestamps,
  });
  // One resolved slot per (tenant, record, level, approver) — re-resolution is idempotent.
  await q.addIndex(TableName.RecordApprovers, ['tenant_id', 'record_type', 'record_id', 'level', 'approver_id'], {
    unique: true,
    name: 'record_approvers_record_level_approver_uq',
  });
  await q.addIndex(TableName.RecordApprovers, ['tenant_id', 'record_type', 'record_id'], {
    name: 'record_approvers_record_idx',
  });
  await q.addIndex(TableName.RecordApprovers, ['tenant_id', 'status'], {
    name: 'record_approvers_tenant_status_idx',
  });
  await q.addIndex(TableName.RecordApprovers, ['tenant_id', 'created_at'], {
    name: 'record_approvers_tenant_created_idx',
  });
  await q.sequelize.query(
    enumCheck(TableName.RecordApprovers, 'approver_type', Object.values(ApproverType)),
  );
  await q.sequelize.query(
    enumCheck(TableName.RecordApprovers, 'status', Object.values(RecordApproverStatus)),
  );
  await q.sequelize.query(
    `ALTER TABLE "${TableName.RecordApprovers}" ADD CONSTRAINT "record_approvers_level_check" CHECK ("level" >= 1)`,
  );

  // ---- approvals — the immutable append-only vote ledger ----
  await q.createTable(TableName.Approvals, {
    id: uuidPk,
    tenant_id: tenantFk,
    record_type: { type: DataTypes.STRING, allowNull: false },
    record_id: { type: DataTypes.UUID, allowNull: false },
    level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    approver_id: { type: DataTypes.UUID, allowNull: false },
    decision: { type: DataTypes.STRING, allowNull: false },
    comment: { type: DataTypes.TEXT, allowNull: true },
    decided_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    // Append-only ledger: created_at only (no updated_at — votes are never mutated).
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  });
  // An approver votes at most once per (tenant, record, level) — enforces the no-double-vote invariant.
  await q.addIndex(TableName.Approvals, ['tenant_id', 'record_type', 'record_id', 'level', 'approver_id'], {
    unique: true,
    name: 'approvals_record_level_approver_uq',
  });
  await q.addIndex(TableName.Approvals, ['tenant_id', 'record_type', 'record_id'], {
    name: 'approvals_record_idx',
  });
  await q.addIndex(TableName.Approvals, ['tenant_id', 'created_at'], {
    name: 'approvals_tenant_created_idx',
  });
  await q.sequelize.query(
    enumCheck(TableName.Approvals, 'decision', Object.values(ApprovalDecision)),
  );
  await q.sequelize.query(
    `ALTER TABLE "${TableName.Approvals}" ADD CONSTRAINT "approvals_level_check" CHECK ("level" >= 1)`,
  );

  // ---- Row-Level Security (FORCE + RESTRICTIVE on tenant_id) for every table ----
  const stmts = [
    ...rlsPolicyStatements(TableName.ApprovalPolicies),
    ...rlsPolicyStatements(TableName.ApprovalHierarchy),
    ...rlsPolicyStatements(TableName.ApproverGroups),
    ...rlsPolicyStatements(TableName.ApproverGroupMembers),
    ...rlsPolicyStatements(TableName.RecordApprovers),
    ...rlsPolicyStatements(TableName.Approvals),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // Drop in reverse dependency order (members → groups; ledger/chain before policies).
  await q.dropTable(TableName.Approvals);
  await q.dropTable(TableName.RecordApprovers);
  await q.dropTable(TableName.ApproverGroupMembers);
  await q.dropTable(TableName.ApproverGroups);
  await q.dropTable(TableName.ApprovalHierarchy);
  await q.dropTable(TableName.ApprovalPolicies);
}
