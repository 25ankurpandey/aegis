import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import {
  TableName,
  InvoiceStatus,
  InvoiceTransactionType,
  InvoiceActivityType,
  InvoiceDuplicateStatus,
  ApprovalDecision,
} from '@aegis/shared-enums';
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
const invoiceFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Invoices, key: 'id' },
  onDelete: 'CASCADE',
};
/** Nullable audit columns (who created / last mutated the row). */
const auditColumns = {
  created_by: { type: DataTypes.UUID, allowNull: true },
  updated_by: { type: DataTypes.UUID, allowNull: true },
};

/** Allowed value sets for the CHECK constraints below — kept in sync with the domain enums. */
const INVOICE_STATUS_VALUES = Object.values(InvoiceStatus);
const INVOICE_TXN_TYPE_VALUES = Object.values(InvoiceTransactionType);
const INVOICE_DUPLICATE_STATUS_VALUES = Object.values(InvoiceDuplicateStatus);
const INVOICE_APPROVAL_DECISION_VALUES = Object.values(ApprovalDecision);

/** Renders a SQL IN-list literal (single-quoted) for a CHECK constraint. */
const inList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/** Header-level invoice schema (no line items / no GL codes). Money in integer minor units. */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // invoices (aggregate root + status state machine)
  await q.createTable(TableName.Invoices, {
    id: uuidPk,
    tenant_id: tenantFk,
    vendor_id: { type: DataTypes.UUID, allowNull: true },
    vendor_name: { type: DataTypes.STRING, allowNull: false },
    invoice_number: { type: DataTypes.STRING, allowNull: false },
    invoice_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    amount_minor: { type: DataTypes.BIGINT, allowNull: false },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    transaction_type: { type: DataTypes.STRING, allowNull: false, defaultValue: InvoiceTransactionType.Debit },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: InvoiceStatus.Received },
    auto_approved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    auto_approved_by: { type: DataTypes.STRING, allowNull: true },
    approval_policy_id: { type: DataTypes.UUID, allowNull: true },
    submitted_by: { type: DataTypes.UUID, allowNull: true },
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    // Optimistic-lock counter (Sequelize `version: 'lock_version'`) — concurrent approvers on the
    // same invoice status machine get an OptimisticLockError instead of silently clobbering.
    lock_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps,
  });
  await q.addIndex(TableName.Invoices, ['tenant_id', 'status'], { name: 'invoices_tenant_status_idx' });
  await q.addIndex(TableName.Invoices, ['tenant_id', 'created_at'], { name: 'invoices_tenant_created_at_idx' });
  // FK index for vendor lookups (vendor_id is a nullable, cross-service reference).
  await q.addIndex(TableName.Invoices, ['tenant_id', 'vendor_id'], { name: 'invoices_tenant_vendor_idx' });
  // Per-vendor invoice-number lookup / dedup support. NON-unique: vendor_id is nullable (NULLs are
  // distinct in Postgres unique indexes, so a unique index would not actually dedup numberless
  // vendors) and confirmed-duplicate invoices intentionally share an invoice_number. A true
  // partial-unique dedup is a product decision (see B6 §c) layered on top of this lookup index.
  await q.addIndex(TableName.Invoices, ['tenant_id', 'vendor_id', 'invoice_number'], {
    name: 'invoices_tenant_vendor_number_idx',
  });
  // Duplicate-detection signature: NON-unique by design — a flagged duplicate is itself a real
  // invoice row that shares (vendor_name, invoice_number, amount_minor) with its original.
  await q.addIndex(TableName.Invoices, ['tenant_id', 'vendor_name', 'invoice_number', 'amount_minor'], {
    name: 'invoices_dup_signature_idx',
  });
  // CHECK: status / transaction_type confined to their enum value set; money never negative.
  await q.addConstraint(TableName.Invoices, {
    type: 'check',
    fields: ['status'],
    name: 'invoices_status_chk',
    where: Sequelize.literal(`status IN (${inList(INVOICE_STATUS_VALUES)})`),
  });
  await q.addConstraint(TableName.Invoices, {
    type: 'check',
    fields: ['transaction_type'],
    name: 'invoices_transaction_type_chk',
    where: Sequelize.literal(`transaction_type IN (${inList(INVOICE_TXN_TYPE_VALUES)})`),
  });
  await q.addConstraint(TableName.Invoices, {
    type: 'check',
    fields: ['amount_minor'],
    name: 'invoices_amount_minor_nonneg_chk',
    where: Sequelize.literal('amount_minor >= 0'),
  });

  // invoice_metadata (1:1 header attributes)
  await q.createTable(TableName.InvoiceMetadata, {
    id: uuidPk,
    tenant_id: tenantFk,
    invoice_id: { ...invoiceFk, unique: true },
    invoice_number: { type: DataTypes.STRING, allowNull: false },
    invoice_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    transaction_type: { type: DataTypes.STRING, allowNull: false, defaultValue: InvoiceTransactionType.Debit },
    amount_minor: { type: DataTypes.BIGINT, allowNull: false },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    ...auditColumns,
    ...timestamps,
  });
  // FK index on the tenant scope (invoice_id already carries a UNIQUE index for the 1:1 link).
  await q.addIndex(TableName.InvoiceMetadata, ['tenant_id', 'invoice_id'], {
    name: 'invoice_metadata_tenant_invoice_idx',
  });
  await q.addConstraint(TableName.InvoiceMetadata, {
    type: 'check',
    fields: ['transaction_type'],
    name: 'invoice_metadata_transaction_type_chk',
    where: Sequelize.literal(`transaction_type IN (${inList(INVOICE_TXN_TYPE_VALUES)})`),
  });
  await q.addConstraint(TableName.InvoiceMetadata, {
    type: 'check',
    fields: ['amount_minor'],
    name: 'invoice_metadata_amount_minor_nonneg_chk',
    where: Sequelize.literal('amount_minor >= 0'),
  });

  // invoice_duplicates (detected duplicate links)
  await q.createTable(TableName.InvoiceDuplicates, {
    id: uuidPk,
    tenant_id: tenantFk,
    invoice_id: invoiceFk,
    duplicate_of: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Invoices, key: 'id' }, onDelete: 'CASCADE' },
    signature: { type: DataTypes.STRING, allowNull: false },
    reason: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'flagged' },
    resolved_by: { type: DataTypes.UUID, allowNull: true },
    ...auditColumns,
    ...timestamps,
  });
  await q.addIndex(TableName.InvoiceDuplicates, ['tenant_id', 'invoice_id'], { name: 'invoice_dup_tenant_invoice_idx' });
  await q.addIndex(TableName.InvoiceDuplicates, ['tenant_id', 'status'], { name: 'invoice_dup_tenant_status_idx' });
  await q.addIndex(TableName.InvoiceDuplicates, ['tenant_id', 'created_at'], { name: 'invoice_dup_tenant_created_at_idx' });
  // FK index for the back-reference to the original invoice.
  await q.addIndex(TableName.InvoiceDuplicates, ['duplicate_of'], { name: 'invoice_dup_duplicate_of_idx' });
  // One duplicate link per (invoice, original) pair — the natural idempotency key for detection.
  await q.addIndex(TableName.InvoiceDuplicates, ['tenant_id', 'invoice_id', 'duplicate_of'], {
    unique: true,
    name: 'invoice_dup_pair_uq',
  });
  await q.addConstraint(TableName.InvoiceDuplicates, {
    type: 'check',
    fields: ['status'],
    name: 'invoice_dup_status_chk',
    where: Sequelize.literal(`status IN (${inList(INVOICE_DUPLICATE_STATUS_VALUES)})`),
  });

  // invoice_approvals (per-level approval votes)
  await q.createTable(TableName.InvoiceApprovals, {
    id: uuidPk,
    tenant_id: tenantFk,
    invoice_id: invoiceFk,
    approver_id: { type: DataTypes.UUID, allowNull: false },
    approval_level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    decision: { type: DataTypes.STRING, allowNull: false },
    comment: { type: DataTypes.STRING, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...auditColumns,
    ...timestamps,
  });
  await q.addIndex(TableName.InvoiceApprovals, ['tenant_id', 'invoice_id'], { name: 'invoice_approvals_tenant_invoice_idx' });
  await q.addIndex(TableName.InvoiceApprovals, ['tenant_id', 'created_at'], { name: 'invoice_approvals_tenant_created_at_idx' });
  // FK index for "approvals by this approver" lookups.
  await q.addIndex(TableName.InvoiceApprovals, ['tenant_id', 'approver_id'], { name: 'invoice_approvals_tenant_approver_idx' });
  await q.addConstraint(TableName.InvoiceApprovals, {
    type: 'check',
    fields: ['decision'],
    name: 'invoice_approvals_decision_chk',
    where: Sequelize.literal(`decision IN (${inList(INVOICE_APPROVAL_DECISION_VALUES)})`),
  });
  await q.addConstraint(TableName.InvoiceApprovals, {
    type: 'check',
    fields: ['approval_level'],
    name: 'invoice_approvals_level_pos_chk',
    where: Sequelize.literal('approval_level >= 1'),
  });

  // invoice_activities (append-only timeline — created_at only)
  await q.createTable(TableName.InvoiceActivities, {
    id: uuidPk,
    tenant_id: tenantFk,
    invoice_id: invoiceFk,
    user_id: { type: DataTypes.UUID, allowNull: true },
    activity_type: { type: DataTypes.STRING, allowNull: false },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    correlation_id: { type: DataTypes.STRING, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  });
  await q.addIndex(TableName.InvoiceActivities, ['tenant_id', 'invoice_id'], { name: 'invoice_activities_tenant_invoice_idx' });
  // Timeline reads ordered by recency (append-only — no status/soft-delete/updated_by here).
  await q.addIndex(TableName.InvoiceActivities, ['tenant_id', 'created_at'], { name: 'invoice_activities_tenant_created_at_idx' });
  await q.addConstraint(TableName.InvoiceActivities, {
    type: 'check',
    fields: ['activity_type'],
    name: 'invoice_activities_activity_type_chk',
    where: Sequelize.literal(`activity_type IN (${inList(Object.values(InvoiceActivityType))})`),
  });

  // Row-Level Security (tenant_id keyed, FORCE + RESTRICTIVE) on every table.
  const stmts = [
    ...rlsPolicyStatements(TableName.Invoices),
    ...rlsPolicyStatements(TableName.InvoiceMetadata),
    ...rlsPolicyStatements(TableName.InvoiceDuplicates),
    ...rlsPolicyStatements(TableName.InvoiceApprovals),
    ...rlsPolicyStatements(TableName.InvoiceActivities),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.InvoiceActivities);
  await q.dropTable(TableName.InvoiceApprovals);
  await q.dropTable(TableName.InvoiceDuplicates);
  await q.dropTable(TableName.InvoiceMetadata);
  await q.dropTable(TableName.Invoices);
}
