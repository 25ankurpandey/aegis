import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * Per-tenant ERP connector configuration. Secrets are not stored here: credentials_ref points to the
 * secret proxy/parameter store. The connector worker resolves this row before pushing a transaction.
 */
const TABLE = TableName.ConnectorConfigs;

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
};

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TABLE, {
    id: uuidPk,
    tenant_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.Tenants, key: 'id' },
      onDelete: 'CASCADE',
    },
    kind: { type: DataTypes.STRING, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    base_url: { type: DataTypes.STRING, allowNull: true },
    credentials_ref: { type: DataTypes.STRING, allowNull: true },
    settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    ...timestamps,
  });

  await q.addIndex(TABLE, ['tenant_id', 'kind'], {
    unique: true,
    name: 'connector_configs_tenant_kind_uq',
  });
  await q.addIndex(TABLE, ['tenant_id', 'active'], { name: 'connector_configs_tenant_active_idx' });

  for (const stmt of rlsPolicyStatements(TABLE)) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TABLE);
}
