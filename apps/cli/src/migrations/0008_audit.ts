import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TableName.AuditLog, {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    actor_id: { type: DataTypes.UUID, allowNull: true },
    action: { type: DataTypes.STRING, allowNull: false },
    outcome: { type: DataTypes.STRING, allowNull: false },
    resource_type: { type: DataTypes.STRING, allowNull: true },
    resource_id: { type: DataTypes.UUID, allowNull: true },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    prev_hash: { type: DataTypes.STRING, allowNull: false },
    hash: { type: DataTypes.STRING, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  });
  await q.addIndex(TableName.AuditLog, ['tenant_id', 'created_at'], { name: 'audit_log_tenant_time_idx' });

  for (const stmt of rlsPolicyStatements(TableName.AuditLog)) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.AuditLog);
}
