import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `invoice_activities` table — the append-only invoice timeline (`created_at` only,
 * no `updated_at`). Tenant-scoped (RLS).
 */
export function defineInvoiceActivity(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.InvoiceActivities,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      invoice_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: true },
      activity_type: { type: DataTypes.STRING, allowNull: false },
      details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      correlation_id: { type: DataTypes.STRING, allowNull: true },
    },
    {
      tableName: TableName.InvoiceActivities,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );
}
