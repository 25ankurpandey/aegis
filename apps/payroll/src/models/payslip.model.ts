import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, PayslipStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `payslips` table (per-employee result of a pay-run; net pay is field-encrypted). */
export function definePayslip(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Payslips,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      pay_run_id: { type: DataTypes.UUID, allowNull: false },
      employee_id: { type: DataTypes.UUID, allowNull: false },
      gross: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      taxable_base: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      total_tax: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      total_deductions: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      net_enc: { type: DataTypes.TEXT, allowNull: true },
      currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: PayslipStatus.Draft },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.Payslips, ...baseModelOptions },
  );
}
