import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { modelOptions } from '@aegis/db';
import { TableName, ExpenseReportStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `expense_reports` table (the lifecycle aggregate root; tenant-scoped + RLS).
 * Money columns are BIGINT integer minor units; the report number is a per-tenant sequence.
 */
export function defineExpenseReport(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ExpenseReports,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      report_number: { type: DataTypes.BIGINT, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: ExpenseReportStatus.Open,
      },
      submitter_id: { type: DataTypes.UUID, allowNull: false },
      total_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
      // Workflow-rule annotations (assign_team / add_tag): owning team + classification tags applied by
      // the engine's RecordUpdated follow-on. Nullable — most reports carry neither.
      team_id: { type: DataTypes.UUID, allowNull: true },
      assignee_id: { type: DataTypes.UUID, allowNull: true },
      tags: { type: DataTypes.JSONB, allowNull: true },
      submitted_at: { type: DataTypes.DATE, allowNull: true },
      synced_at: { type: DataTypes.DATE, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: TableName.ExpenseReports,
      // Long-lived lifecycle aggregate: paranoid soft-delete (deleted_at) + optimistic locking on
      // `lock_version` so concurrent submitters/approvers can't lose updates on the status machine.
      ...modelOptions({ paranoid: true, version: true }),
    },
  );
}
