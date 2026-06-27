import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { modelOptions } from '@aegis/db';
import { TableName, InvoiceStatus, InvoiceTransactionType } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `invoices` table — the aggregate root (header-level). Money lives in integer minor
 * units (`amount_minor` as BIGINT); tenant-scoped (RLS); soft-deletable via `deleted_at`.
 */
export function defineInvoice(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Invoices,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      vendor_id: { type: DataTypes.UUID, allowNull: true },
      vendor_name: { type: DataTypes.STRING, allowNull: false },
      invoice_number: { type: DataTypes.STRING, allowNull: false },
      invoice_date: { type: DataTypes.DATEONLY, allowNull: false },
      due_date: { type: DataTypes.DATEONLY, allowNull: true },
      amount_minor: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      transaction_type: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: InvoiceTransactionType.Debit,
      },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: InvoiceStatus.Received },
      // Workflow-rule annotations (assign_team / add_tag): owning team + classification tags applied by
      // the engine's RecordUpdated follow-on. Nullable — most invoices carry neither.
      team_id: { type: DataTypes.UUID, allowNull: true },
      assignee_id: { type: DataTypes.UUID, allowNull: true },
      tags: { type: DataTypes.JSONB, allowNull: true },
      auto_approved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      auto_approved_by: { type: DataTypes.STRING, allowNull: true },
      approval_policy_id: { type: DataTypes.UUID, allowNull: true },
      submitted_by: { type: DataTypes.UUID, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    // Soft-deletable master entity: paranoid maps `deleted_at` so destroy() sets it instead of
    // hard-deleting, and default finders auto-exclude soft-deleted rows. `version` enables optimistic
    // locking on `lock_version` so concurrent approvers can't silently clobber each other.
    { tableName: TableName.Invoices, ...modelOptions({ paranoid: true, version: true }) },
  );
}
