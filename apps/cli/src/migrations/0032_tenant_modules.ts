import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

// Physical table name. `tenant_modules` is not (yet) in the TableName enum (shared-enums is owned
// elsewhere), so it is referenced as a literal here and in the repository.
const TENANT_MODULES = 'tenant_modules';

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

/**
 * tenant_modules: the per-tenant entitlement ledger for the pay-per-module platform. One row per
 * (tenant, module) records whether that module is enabled for the tenant, under which plan, its
 * lifecycle status, an optional expiry, and an optional quota bag. Tenant-scoped (tenant_id NOT
 * NULL) with FORCE + RESTRICTIVE RLS exactly like every other tenant table.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TENANT_MODULES, {
    id: uuidPk,
    tenant_id: tenantFk,
    module_id: { type: DataTypes.TEXT, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    plan: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'active' },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    quota: { type: DataTypes.JSONB, allowNull: true },
    ...timestamps,
  });

  // One entitlement row per (tenant, module).
  await q.addIndex(TENANT_MODULES, ['tenant_id', 'module_id'], {
    unique: true,
    name: 'tenant_modules_tenant_module_uq',
  });
  // Listing a tenant's enabled modules (the common entitlement lookup).
  await q.addIndex(TENANT_MODULES, ['tenant_id', 'enabled'], {
    name: 'tenant_modules_tenant_enabled_idx',
  });

  // Row-Level Security (tenant_id keyed, FORCE + RESTRICTIVE) — mirrors the other tenant tables.
  const stmts = rlsPolicyStatements(TENANT_MODULES);
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
  // The non-owner runtime role reaches tables through ALTER DEFAULT PRIVILEGES set at DB init, but
  // grant explicitly too so the entitlement table's app access is self-documented and robust to a
  // DB provisioned without those default privileges.
  await q.sequelize.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "${TENANT_MODULES}" TO aegis_app;`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TENANT_MODULES);
}
