import { DataTypes, Op, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { NotificationChannel, TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * notification_preferences (W3-10) — per-tenant/per-user channel opt-out for the notification
 * service. A row pins one (event_type, channel) for one user (or a tenant-wide default when
 * `user_id` is NULL); the ABSENCE of a row is default-on (the channel is delivered). Tenant-scoped
 * with FORCE + RESTRICTIVE Row-Level Security keyed on app.current_tenant (so a preference can never
 * leak across tenants), with composite indexes for the consumer's hot lookup path. Mirrors the
 * structure of 0011/0012 (RLS + indexes + enum CHECK).
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
  await q.createTable(TableName.NotificationPreferences, {
    id: uuidPk,
    tenant_id: tenantFk,
    // NULL user_id = a tenant-wide default for the (event_type, channel) pair.
    user_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: TableName.Users, key: 'id' },
      onDelete: 'CASCADE',
    },
    event_type: { type: DataTypes.STRING, allowNull: false },
    channel: { type: DataTypes.STRING, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // Audit: who set / last changed this preference (nullable — system-seeded rows have none).
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    ...timestamps,
  });

  // At most one preference per (tenant, user, event_type, channel). Two partial-unique indexes cover
  // the NULL-user (tenant default) and non-NULL-user cases, since NULLs are distinct in a plain
  // UNIQUE index and would otherwise allow duplicate tenant-wide defaults.
  await q.addIndex(TableName.NotificationPreferences, ['tenant_id', 'user_id', 'event_type', 'channel'], {
    unique: true,
    name: 'notification_preferences_user_event_channel_uq',
    where: { user_id: { [Op.ne]: null } },
  });
  await q.addIndex(TableName.NotificationPreferences, ['tenant_id', 'event_type', 'channel'], {
    unique: true,
    name: 'notification_preferences_tenant_default_uq',
    where: { user_id: null },
  });
  // The consumer's hot lookup: "is (event_type, channel) enabled for this user?" (and its default).
  await q.addIndex(TableName.NotificationPreferences, ['tenant_id', 'event_type', 'channel', 'user_id'], {
    name: 'notification_preferences_lookup_idx',
  });

  // `channel` is drawn from the NotificationChannel set (in_app | email | sms).
  await q.addConstraint(TableName.NotificationPreferences, {
    type: 'check',
    fields: ['channel'],
    name: 'notification_preferences_channel_chk',
    where: { channel: { [Op.in]: Object.values(NotificationChannel) } },
  });

  // Row-Level Security (FORCE + RESTRICTIVE on tenant_id).
  for (const stmt of rlsPolicyStatements(TableName.NotificationPreferences)) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.NotificationPreferences);
}
