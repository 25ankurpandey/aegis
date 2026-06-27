import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `earning_codes` table (per-tenant catalog of earning types). */
export function defineEarningCode(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.EarningCodes,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      name: { type: DataTypes.STRING, allowNull: false },
      taxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      recurring_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.EarningCodes, ...baseModelOptions, paranoid: true, deletedAt: 'deleted_at' },
  );
}
