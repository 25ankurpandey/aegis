import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines `connector_configs`, the tenant-scoped ERP connector configuration catalog. */
export function defineConnectorConfig(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ConnectorConfigs,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      kind: { type: DataTypes.STRING, allowNull: false },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      base_url: { type: DataTypes.STRING, allowNull: true },
      credentials_ref: { type: DataTypes.STRING, allowNull: true },
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.ConnectorConfigs, ...baseModelOptions },
  );
}
