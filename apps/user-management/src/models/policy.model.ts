import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { modelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the tenant-owned ABAC policy catalog administered by the PAP. */
export function definePolicy(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Policies,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      permission: { type: DataTypes.STRING, allowNull: false },
      effect: { type: DataTypes.STRING, allowNull: false, defaultValue: 'allow' },
      rule: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.Policies, ...modelOptions({ paranoid: true }) },
  );
}
