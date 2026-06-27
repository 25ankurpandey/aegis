import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, PayslipLineSource } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `payslip_lines` table (the itemised breakdown behind a payslip's totals). */
export function definePayslipLine(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.PayslipLines,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      payslip_id: { type: DataTypes.UUID, allowNull: false },
      kind: { type: DataTypes.STRING, allowNull: false },
      code_id: { type: DataTypes.UUID, allowNull: true },
      source: { type: DataTypes.STRING, allowNull: false, defaultValue: PayslipLineSource.Base },
      source_ref: { type: DataTypes.STRING, allowNull: true },
      amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      taxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.PayslipLines, ...baseModelOptions },
  );
}
