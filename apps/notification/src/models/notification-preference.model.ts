import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, NotificationChannel } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `notification_preferences` table — per-tenant/per-user channel opt-out (W3-10). A row
 * pins one (event_type, channel) for one user (or a tenant-wide default when `user_id` is NULL);
 * its absence is DEFAULT-ON. Tenant-scoped via RLS (the migration enforces it at the DB layer).
 */
export function defineNotificationPreference(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.NotificationPreferences,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: true },
      event_type: { type: DataTypes.STRING, allowNull: false },
      channel: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: NotificationChannel.Email,
      },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.NotificationPreferences, ...baseModelOptions },
  );
}
