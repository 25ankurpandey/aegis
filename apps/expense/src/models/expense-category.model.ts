import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `expense_categories` table (a per-tenant label for expense items; tenant-scoped + RLS). */
export function defineExpenseCategory(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ExpenseCategories,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      code: { type: DataTypes.STRING, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: TableName.ExpenseCategories,
      ...baseModelOptions,
      // Long-lived master entity: paranoid soft-delete (deleted_at) per the migration.
      paranoid: true,
      deletedAt: 'deleted_at',
    },
  );
}
