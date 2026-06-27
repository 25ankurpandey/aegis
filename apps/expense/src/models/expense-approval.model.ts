import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `expense_approvals` table (one decision in a report's approval chain; tenant-scoped + RLS). */
export function defineExpenseApproval(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ExpenseApprovals,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      report_id: { type: DataTypes.UUID, allowNull: false },
      approver_id: { type: DataTypes.UUID, allowNull: false },
      decision: { type: DataTypes.STRING, allowNull: false },
      level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      comment: { type: DataTypes.STRING, allowNull: true },
      decided_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: TableName.ExpenseApprovals, ...baseModelOptions },
  );
}
