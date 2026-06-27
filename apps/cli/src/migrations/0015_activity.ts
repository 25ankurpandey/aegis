import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * W3-11 — shared polymorphic activity timeline (`activity_log`).
 *
 * One tenant-scoped, append-only, RLS-protected table that records who-did-what for ANY business
 * record (record_type + record_id), the business-timeline counterpart to the security `audit_log`.
 * Additive: the existing per-service *_activities tables are left in place this pass (follow-up:
 * migrate invoice_activities / expense_activities onto this shared table).
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TableName.ActivityLog, {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    record_type: { type: DataTypes.STRING, allowNull: false },
    record_id: { type: DataTypes.UUID, allowNull: false },
    actor_id: { type: DataTypes.UUID, allowNull: true },
    action: { type: DataTypes.STRING, allowNull: false },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    correlation_id: { type: DataTypes.STRING, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  });

  // W3-14 — composite index backing the primary read pattern: one record's timeline, newest first.
  await q.addIndex(TableName.ActivityLog, ['tenant_id', 'record_type', 'record_id', 'created_at'], {
    name: 'activity_log_tenant_record_time_idx',
  });
  // Secondary: per-tenant recency scan across all record types (firehose / recent-activity views).
  await q.addIndex(TableName.ActivityLog, ['tenant_id', 'created_at'], {
    name: 'activity_log_tenant_time_idx',
  });

  for (const stmt of rlsPolicyStatements(TableName.ActivityLog)) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.ActivityLog);
}
