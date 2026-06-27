import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName, ExpenseReportStatus, ExpenseActivityType } from '@aegis/shared-enums';
import { ExpenseDecision } from '@aegis/shared-constants';
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
// Audit columns for mutable entities (who created/last-mutated the row). Nullable: legacy/system
// writes (e.g. seeds, ERP sync) may not carry a principal. NOT added to append-only log tables.
const audit = {
  created_by: { type: DataTypes.UUID, allowNull: true },
  updated_by: { type: DataTypes.UUID, allowNull: true },
};
// Paranoid soft-delete marker for long-lived master/aggregate entities. NULL = live row.
const softDelete = {
  deleted_at: { type: DataTypes.DATE, allowNull: true },
};
// Optimistic-lock counter (Sequelize `version: 'lock_version'`) for mutable aggregate roots.
const lockVersion = {
  lock_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
};
const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};
const reportFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.ExpenseReports, key: 'id' },
  onDelete: 'CASCADE',
};

/**
 * Expense schema: user-entered items under a role-keyed report state machine.
 * NO GL codes, NO document-extracted line items (SPEC §10.1). Money in integer minor units
 * (BIGINT). UUID v4 PKs. Every table is tenant-scoped (tenant_id NOT NULL) + FORCE/RESTRICTIVE RLS.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // expense_categories (tenant label set — NOT GL codes). Long-lived master entity: audited +
  // paranoid soft-delete (deactivated categories must survive for historical expense references).
  await q.createTable(TableName.ExpenseCategories, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    code: { type: DataTypes.STRING, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...audit,
    ...softDelete,
    ...timestamps,
  });
  // Unique per tenant on the free-label code. Postgres treats NULL codes as distinct, so
  // categories without a code are not constrained (the code is an optional label, not a GL code).
  // `expense_categories` is paranoid (soft-delete): scope uniqueness to live rows so a code can be
  // reused after a category is soft-deleted (avoids 23505 on recreate).
  await q.addIndex(TableName.ExpenseCategories, ['tenant_id', 'code'], {
    unique: true,
    name: 'expense_categories_tenant_code_uq',
    where: { deleted_at: null },
  });
  // Listing/filtering categories by tenant in creation order.
  await q.addIndex(TableName.ExpenseCategories, ['tenant_id', 'created_at'], {
    name: 'expense_categories_tenant_created_idx',
  });

  // expense_reports (the report container + status state machine). Lifecycle aggregate root:
  // audited + paranoid soft-delete (a report must remain referenceable from approvals/activities
  // after removal).
  await q.createTable(TableName.ExpenseReports, {
    id: uuidPk,
    tenant_id: tenantFk,
    report_number: { type: DataTypes.BIGINT, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: ExpenseReportStatus.Open },
    submitter_id: { type: DataTypes.UUID, allowNull: false },
    total_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'USD' },
    submitted_at: { type: DataTypes.DATE, allowNull: true },
    synced_at: { type: DataTypes.DATE, allowNull: true },
    ...audit,
    ...softDelete,
    ...lockVersion,
    ...timestamps,
  });
  // `expense_reports` is paranoid (soft-delete): scope the (tenant_id, report_number) uniqueness to
  // live rows so a report number is freed once a report is soft-deleted (avoids 23505 on recreate).
  await q.addIndex(TableName.ExpenseReports, ['tenant_id', 'report_number'], {
    unique: true,
    name: 'expense_reports_tenant_number_uq',
    where: { deleted_at: null },
  });
  await q.addIndex(TableName.ExpenseReports, ['tenant_id', 'status'], {
    name: 'expense_reports_tenant_status_idx',
  });
  // Recency-ordered tenant listing (the report list view).
  await q.addIndex(TableName.ExpenseReports, ['tenant_id', 'created_at'], {
    name: 'expense_reports_tenant_created_idx',
  });
  // The list view also filters by submitter (a user's own reports).
  await q.addIndex(TableName.ExpenseReports, ['tenant_id', 'submitter_id'], {
    name: 'expense_reports_tenant_submitter_idx',
  });
  // status constrained to the lifecycle enum; the denormalized total can never be negative.
  await q.addConstraint(TableName.ExpenseReports, {
    type: 'check',
    fields: ['status'],
    name: 'expense_reports_status_check',
    where: { status: Object.values(ExpenseReportStatus) },
  });
  await q.sequelize.query(
    'ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_total_amount_check" CHECK ("total_amount" >= 0)',
  );

  // expenses (user-entered items under a report; report_id nullable until assigned)
  await q.createTable(TableName.Expenses, {
    id: uuidPk,
    tenant_id: tenantFk,
    report_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: TableName.ExpenseReports, key: 'id' },
      onDelete: 'SET NULL',
    },
    category_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: TableName.ExpenseCategories, key: 'id' },
      onDelete: 'SET NULL',
    },
    amount: { type: DataTypes.BIGINT, allowNull: false },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'USD' },
    merchant: { type: DataTypes.STRING, allowNull: true },
    incurred_on: { type: DataTypes.DATEONLY, allowNull: true },
    description: { type: DataTypes.STRING, allowNull: true },
    receipt_ref: { type: DataTypes.STRING, allowNull: true }, // pointer only; no extraction
    created_by: { type: DataTypes.UUID, allowNull: false },
    // created_by already present above; pair it with updated_by for full mutation audit.
    updated_by: { type: DataTypes.UUID, allowNull: true },
    assigned_to_report_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });
  await q.addIndex(TableName.Expenses, ['tenant_id', 'report_id'], {
    name: 'expenses_tenant_report_idx',
  });
  // Index the category FK (joins/filters by category) and support recency-ordered tenant listing.
  await q.addIndex(TableName.Expenses, ['tenant_id', 'category_id'], {
    name: 'expenses_tenant_category_idx',
  });
  await q.addIndex(TableName.Expenses, ['tenant_id', 'created_at'], {
    name: 'expenses_tenant_created_idx',
  });
  // A line item's amount is a non-negative integer minor-unit value.
  await q.sequelize.query(
    'ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_check" CHECK ("amount" >= 0)',
  );

  // expense_approvals (decision records backing the state machine)
  await q.createTable(TableName.ExpenseApprovals, {
    id: uuidPk,
    tenant_id: tenantFk,
    report_id: reportFk,
    approver_id: { type: DataTypes.UUID, allowNull: false },
    decision: { type: DataTypes.STRING, allowNull: false },
    level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    comment: { type: DataTypes.STRING, allowNull: true },
    decided_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    ...timestamps,
  });
  await q.addIndex(TableName.ExpenseApprovals, ['tenant_id', 'report_id'], {
    name: 'expense_approvals_tenant_report_idx',
  });
  // decision constrained to the allowed verdict set; approval level is a non-negative ordinal.
  await q.addConstraint(TableName.ExpenseApprovals, {
    type: 'check',
    fields: ['decision'],
    name: 'expense_approvals_decision_check',
    where: { decision: [ExpenseDecision.Approved, ExpenseDecision.Rejected] },
  });
  await q.sequelize.query(
    'ALTER TABLE "expense_approvals" ADD CONSTRAINT "expense_approvals_level_check" CHECK ("level" >= 0)',
  );

  // expense_comments (per-report discussion thread)
  await q.createTable(TableName.ExpenseComments, {
    id: uuidPk,
    tenant_id: tenantFk,
    report_id: reportFk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    body: { type: DataTypes.STRING, allowNull: false },
    ...timestamps,
  });
  await q.addIndex(TableName.ExpenseComments, ['tenant_id', 'report_id'], {
    name: 'expense_comments_tenant_report_idx',
  });

  // expense_activities (append-only audit feed)
  await q.createTable(TableName.ExpenseActivities, {
    id: uuidPk,
    tenant_id: tenantFk,
    report_id: reportFk,
    user_id: { type: DataTypes.UUID, allowNull: true },
    activity_type: { type: DataTypes.STRING, allowNull: false },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    ...timestamps,
  });
  await q.addIndex(TableName.ExpenseActivities, ['tenant_id', 'report_id'], {
    name: 'expense_activities_tenant_report_idx',
  });
  // activity_type constrained to the known activity-feed event set.
  await q.addConstraint(TableName.ExpenseActivities, {
    type: 'check',
    fields: ['activity_type'],
    name: 'expense_activities_type_check',
    where: { activity_type: Object.values(ExpenseActivityType) },
  });

  // Row-Level Security (tenant_id keyed, FORCE + RESTRICTIVE) on every table.
  const stmts = [
    ...rlsPolicyStatements(TableName.ExpenseCategories),
    ...rlsPolicyStatements(TableName.ExpenseReports),
    ...rlsPolicyStatements(TableName.Expenses),
    ...rlsPolicyStatements(TableName.ExpenseApprovals),
    ...rlsPolicyStatements(TableName.ExpenseComments),
    ...rlsPolicyStatements(TableName.ExpenseActivities),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.ExpenseActivities);
  await q.dropTable(TableName.ExpenseComments);
  await q.dropTable(TableName.ExpenseApprovals);
  await q.dropTable(TableName.Expenses);
  await q.dropTable(TableName.ExpenseReports);
  await q.dropTable(TableName.ExpenseCategories);
}
