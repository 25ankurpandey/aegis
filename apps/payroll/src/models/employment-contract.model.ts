import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, ContractType, PayFrequency } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `employment_contracts` table (effective-dated; base pay is field-encrypted). */
export function defineEmploymentContract(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.EmploymentContracts,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      employee_id: { type: DataTypes.UUID, allowNull: false },
      effective_from: { type: DataTypes.DATEONLY, allowNull: false },
      effective_to: { type: DataTypes.DATEONLY, allowNull: true },
      type: { type: DataTypes.STRING, allowNull: false, defaultValue: ContractType.Salaried },
      base_amount_enc: { type: DataTypes.TEXT, allowNull: true },
      currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
      fte: { type: DataTypes.DECIMAL(5, 4), allowNull: true },
      pay_frequency: { type: DataTypes.STRING, allowNull: false, defaultValue: PayFrequency.Monthly },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.EmploymentContracts, ...baseModelOptions },
  );
}
