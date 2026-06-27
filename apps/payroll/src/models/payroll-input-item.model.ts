import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, PayrollInputStatus, SettlementMode } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `payroll_input_items` table (inbound earnings/deductions, idempotent per source ref). */
export function definePayrollInputItem(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.PayrollInputItems,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      employee_id: { type: DataTypes.UUID, allowNull: false },
      source: { type: DataTypes.STRING, allowNull: false },
      source_ref: { type: DataTypes.STRING, allowNull: true },
      idempotency_key: { type: DataTypes.STRING, allowNull: false, unique: true },
      amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      taxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      settlement: { type: DataTypes.STRING, allowNull: false, defaultValue: SettlementMode.Cyclic },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: PayrollInputStatus.Pending },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.PayrollInputItems, ...baseModelOptions },
  );
}
