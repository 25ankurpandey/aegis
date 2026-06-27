import { DataTypes, Op, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import {
  EmailNotificationStatus,
  NotificationCode,
  TableName,
} from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

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
  // In-app notifications (one row per recipient).
  await q.createTable(TableName.Notifications, {
    id: uuidPk,
    tenant_id: tenantFk,
    user_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Users, key: 'id' }, onDelete: 'CASCADE' },
    code: { type: DataTypes.STRING, allowNull: false },
    message: { type: DataTypes.JSONB, allowNull: false },
    correlation_id: { type: DataTypes.STRING, allowNull: true },
    read_at: { type: DataTypes.DATE, allowNull: true },
    // Audit: who emitted / last mutated this in-app row (nullable — system-generated rows have none).
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    ...timestamps,
  });
  await q.addIndex(TableName.Notifications, ['tenant_id', 'user_id', 'read_at'], {
    name: 'notifications_tenant_user_read_idx',
  });
  // Listing the tenant inbox newest-first.
  await q.addIndex(TableName.Notifications, ['tenant_id', 'created_at'], {
    name: 'notifications_tenant_created_idx',
  });
  // FK index for recipient-scoped reads (the leading composite covers tenant+user, but a lone
  // user_id lookup — e.g. ON DELETE CASCADE from users — wants its own index).
  await q.addIndex(TableName.Notifications, ['user_id'], {
    name: 'notifications_user_idx',
  });
  // Idempotent in-app insert: at most one badge per logical event + recipient + code.
  await q.addIndex(TableName.Notifications, ['tenant_id', 'user_id', 'code', 'correlation_id'], {
    unique: true,
    name: 'notifications_dedupe_uq',
  });
  // `code` is drawn from the templated NotificationCode set.
  await q.addConstraint(TableName.Notifications, {
    type: 'check',
    fields: ['code'],
    name: 'notifications_code_chk',
    where: { code: { [Op.in]: Object.values(NotificationCode) } },
  });

  // Email send log (status-tracked, exactly-once via idempotency_key).
  await q.createTable(TableName.EmailNotificationLogs, {
    id: uuidPk,
    tenant_id: tenantFk,
    user_id: { type: DataTypes.UUID, allowNull: true, references: { model: TableName.Users, key: 'id' }, onDelete: 'SET NULL' },
    email: { type: DataTypes.STRING, allowNull: false },
    template_name: { type: DataTypes.STRING, allowNull: false },
    payload: { type: DataTypes.JSONB, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    idempotency_key: { type: DataTypes.STRING, allowNull: false },
    correlation_id: { type: DataTypes.STRING, allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
    sent_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });
  // The linchpin of exactly-once email: one send per logical event (per tenant).
  await q.addIndex(TableName.EmailNotificationLogs, ['tenant_id', 'idempotency_key'], {
    unique: true,
    name: 'email_notification_logs_idempotency_uq',
  });
  await q.addIndex(TableName.EmailNotificationLogs, ['tenant_id', 'status'], {
    name: 'email_notification_logs_tenant_status_idx',
  });
  // Admin compliance view lists newest-first.
  await q.addIndex(TableName.EmailNotificationLogs, ['tenant_id', 'created_at'], {
    name: 'email_notification_logs_tenant_created_idx',
  });
  // FK index for recipient-scoped reads (user_id is nullable / ON DELETE SET NULL).
  await q.addIndex(TableName.EmailNotificationLogs, ['user_id'], {
    name: 'email_notification_logs_user_idx',
  });
  // Append-only ledger, but the row's send state walks a fixed lifecycle.
  await q.addConstraint(TableName.EmailNotificationLogs, {
    type: 'check',
    fields: ['status'],
    name: 'email_notification_logs_status_chk',
    where: { status: { [Op.in]: Object.values(EmailNotificationStatus) } },
  });

  // Row-Level Security (FORCE + RESTRICTIVE on tenant_id) for both tables.
  const stmts = [
    ...rlsPolicyStatements(TableName.Notifications),
    ...rlsPolicyStatements(TableName.EmailNotificationLogs),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.EmailNotificationLogs);
  await q.dropTable(TableName.Notifications);
}
