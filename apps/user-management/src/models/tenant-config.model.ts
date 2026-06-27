import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `tenant_config` table — arbitrary per-tenant settings as JSON keyed by name
 * (multi-tenancy parity, SPEC §11.5). Tenant-scoped + RLS.
 */
export function defineTenantConfig(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.TenantConfig,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      key: { type: DataTypes.STRING, allowNull: false },
      value: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: TableName.TenantConfig, ...baseModelOptions },
  );
}
