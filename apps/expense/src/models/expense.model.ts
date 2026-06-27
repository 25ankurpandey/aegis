import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `expenses` table (a single expense item; tenant-scoped + RLS). Amount is a BIGINT
 * integer minor unit. An item may be standalone or attached to a report (`report_id`).
 */
export function defineExpense(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Expenses,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      report_id: { type: DataTypes.UUID, allowNull: true },
      category_id: { type: DataTypes.UUID, allowNull: true },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
      merchant: { type: DataTypes.STRING, allowNull: true },
      incurred_on: { type: DataTypes.DATEONLY, allowNull: true },
      description: { type: DataTypes.STRING, allowNull: true },
      receipt_ref: { type: DataTypes.STRING, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: false },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      assigned_to_report_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.Expenses, ...baseModelOptions },
  );
}
