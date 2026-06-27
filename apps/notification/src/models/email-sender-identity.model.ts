import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';

/**
 * notification-service-local table name (not in the shared `TableName` enum — see migration
 * 0019_email_plane.ts header). Kept as a single exported constant so the model + repository agree.
 */
export const EMAIL_SENDER_IDENTITIES_TABLE = 'email_sender_identities';

/**
 * Defines the `email_sender_identities` table (G2) — ONE row per tenant carrying the per-tenant
 * sender identity (from_name / from_email / reply_to) AND the email master-switch (`email_enabled`).
 * The absence of a row ⇒ master-switch ON and the provider's configured default From. Tenant-scoped
 * via RLS (the migration enforces it at the DB layer).
 */
export function defineEmailSenderIdentity(s: Sequelize): ModelStatic<Model> {
  return s.define(
    EMAIL_SENDER_IDENTITIES_TABLE,
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      from_name: { type: DataTypes.STRING, allowNull: true },
      from_email: { type: DataTypes.STRING, allowNull: true },
      reply_to: { type: DataTypes.STRING, allowNull: true },
      email_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: EMAIL_SENDER_IDENTITIES_TABLE, ...baseModelOptions },
  );
}
