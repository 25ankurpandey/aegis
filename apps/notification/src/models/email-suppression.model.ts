import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { TableName, EmailSuppressionReason } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `email_suppressions` table (G8) — a tenant-scoped suppression list (bounced /
 * complained / unsubscribed addresses) checked in `EmailSenderService` BEFORE `provider.send`.
 * Append-only (only `created_at`); tenant-scoped via RLS (the migration enforces it at the DB layer).
 */
export function defineEmailSuppression(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.EmailSuppressions,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      address: { type: DataTypes.STRING, allowNull: false },
      reason: { type: DataTypes.STRING, allowNull: false },
      source: { type: DataTypes.STRING, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: TableName.EmailSuppressions,
      underscored: true,
      // Append-only ledger — created_at only, no updated_at column.
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}

export { EmailSuppressionReason };
