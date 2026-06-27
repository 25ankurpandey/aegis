import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * Tenant-level configuration + feature flags (multi-tenancy parity — SPEC §11.5).
 * Both tables are tenant-scoped with FORCE + RESTRICTIVE Row-Level Security keyed on
 * app.current_tenant, so a per-tenant setting/flag can never leak across tenants.
 */

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};
const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
};
const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // Per-tenant settings: an arbitrary key → JSON value, unique per (tenant, key).
  await q.createTable(TableName.TenantConfig, {
    id: uuidPk,
    tenant_id: tenantFk,
    key: { type: DataTypes.STRING, allowNull: false },
    value: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    ...timestamps,
  });
  await q.addIndex(TableName.TenantConfig, ['tenant_id', 'key'], {
    unique: true,
    name: 'tenant_config_tenant_key_uq',
  });

  // Per-tenant feature flags: a flag name → enabled boolean, unique per (tenant, flag).
  await q.createTable(TableName.TenantFeatures, {
    id: uuidPk,
    tenant_id: tenantFk,
    flag: { type: DataTypes.STRING, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps,
  });
  await q.addIndex(TableName.TenantFeatures, ['tenant_id', 'flag'], {
    unique: true,
    name: 'tenant_features_tenant_flag_uq',
  });

  // Row-Level Security (FORCE + RESTRICTIVE on tenant_id).
  const stmts = [
    ...rlsPolicyStatements(TableName.TenantConfig),
    ...rlsPolicyStatements(TableName.TenantFeatures),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.TenantFeatures);
  await q.dropTable(TableName.TenantConfig);
}
