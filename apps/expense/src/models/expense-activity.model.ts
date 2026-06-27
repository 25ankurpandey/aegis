import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `expense_activities` table (an append-only audit feed per report; tenant-scoped + RLS). */
export function defineExpenseActivity(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ExpenseActivities,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      report_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: true },
      activity_type: { type: DataTypes.STRING, allowNull: false },
      details: { type: DataTypes.JSONB, allowNull: true },
    },
    { tableName: TableName.ExpenseActivities, ...baseModelOptions },
  );
}
