import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, EmailNotificationStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `email_notification_logs` table — the exactly-once email ledger (one row per logical
 * event, keyed by a UNIQUE `idempotency_key`; tenant-scoped).
 */
export function defineEmailNotificationLog(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.EmailNotificationLogs,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: true },
      email: { type: DataTypes.STRING, allowNull: false },
      template_name: { type: DataTypes.STRING, allowNull: false },
      payload: { type: DataTypes.JSONB, allowNull: false },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: EmailNotificationStatus.Pending,
      },
      idempotency_key: { type: DataTypes.STRING, allowNull: false },
      correlation_id: { type: DataTypes.STRING, allowNull: true },
      error_message: { type: DataTypes.TEXT, allowNull: true },
      sent_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.EmailNotificationLogs, ...baseModelOptions },
  );
}
