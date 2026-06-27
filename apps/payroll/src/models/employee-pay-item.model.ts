import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, PayFrequency } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `employee_pay_items` table (recurring/one-off earnings + deductions per employee). */
export function defineEmployeePayItem(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.EmployeePayItems,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      employee_id: { type: DataTypes.UUID, allowNull: false },
      code_id: { type: DataTypes.UUID, allowNull: true },
      code_kind: { type: DataTypes.STRING, allowNull: false },
      amount_or_rate: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      frequency: { type: DataTypes.STRING, allowNull: false, defaultValue: PayFrequency.Monthly },
      effective_from: { type: DataTypes.DATEONLY, allowNull: false },
      effective_to: { type: DataTypes.DATEONLY, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.EmployeePayItems, ...baseModelOptions },
  );
}
