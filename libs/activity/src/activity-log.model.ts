import { DataTypes, type ModelStatic, type Model } from 'sequelize';
import { getSequelize } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

let model: ModelStatic<Model> | null = null;

/**
 * The shared, append-only `activity_log` model (defined once on the shared connection).
 *
 * Polymorphic by design: `record_type` + `record_id` point at any business record (invoice,
 * expense, employee, …) so a single tenant-scoped timeline serves every service — the same role
 * `@aegis/audit` plays for security events, this plays for business who-did-what timelines.
 */
export function getActivityModel(): ModelStatic<Model> {
  if (model) return model;
  model = getSequelize().define(
    TableName.ActivityLog,
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      record_type: { type: DataTypes.STRING, allowNull: false },
      record_id: { type: DataTypes.UUID, allowNull: false },
      actor_id: { type: DataTypes.UUID, allowNull: true },
      action: { type: DataTypes.STRING, allowNull: false },
      details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      correlation_id: { type: DataTypes.STRING, allowNull: true },
    },
    {
      tableName: TableName.ActivityLog,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false, // append-only
    },
  );
  return model;
}

/** Reset the cached model (test-only seam — lets specs swap the mocked connection). */
export function resetActivityModel(): void {
  model = null;
}
