import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `tenant_features` table — per-tenant feature flags (multi-tenancy parity, SPEC §11.5).
 * Tenant-scoped + RLS; gating reads a flag's `enabled` state.
 */
export function defineTenantFeature(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.TenantFeatures,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      flag: { type: DataTypes.STRING, allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: TableName.TenantFeatures, ...baseModelOptions },
  );
}
