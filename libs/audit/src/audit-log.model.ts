import { DataTypes, type ModelStatic, type Model } from 'sequelize';
import { getSequelize } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

let model: ModelStatic<Model> | null = null;

/** The append-only audit_log model (defined once on the shared connection). */
export function getAuditModel(): ModelStatic<Model> {
  if (model) return model;
  model = getSequelize().define(
    TableName.AuditLog,
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
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
    },
    {
      tableName: TableName.AuditLog,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false, // append-only
    },
  );
  return model;
}
