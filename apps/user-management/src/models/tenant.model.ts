import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, TenantStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `tenants` table (the root of every tenant's data island). */
export function defineTenant(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Tenants,
    {
      id: uuidPk,
      name: { type: DataTypes.STRING, allowNull: false },
      slug: { type: DataTypes.STRING, allowNull: false, unique: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: TenantStatus.Active },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.Tenants, ...baseModelOptions, paranoid: true, deletedAt: 'deleted_at' },
  );
}
