import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `deduction_codes` table (per-tenant catalog of deduction types). */
export function defineDeductionCode(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.DeductionCodes,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      name: { type: DataTypes.STRING, allowNull: false },
      pre_tax: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      employer_contribution: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.DeductionCodes, ...baseModelOptions, paranoid: true, deletedAt: 'deleted_at' },
  );
}
