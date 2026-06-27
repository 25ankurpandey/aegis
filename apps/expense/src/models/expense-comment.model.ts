import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `expense_comments` table (a free-text comment on a report; tenant-scoped + RLS). */
export function defineExpenseComment(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ExpenseComments,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      report_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      body: { type: DataTypes.STRING, allowNull: false },
    },
    { tableName: TableName.ExpenseComments, ...baseModelOptions },
  );
}
