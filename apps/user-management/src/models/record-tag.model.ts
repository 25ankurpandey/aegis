import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { TableName } from '@aegis/shared-enums';

/**
 * Defines the `record_tags` table — the polymorphic record↔tag join across the three finance record
 * types (`record_type` is an `ApprovalRecordType` value). A real join with a catalog FK (`tag_id`) +
 * provenance (`source`, `added_by`). Append-only: `created_at` only, no `updated_at` (a tag link is
 * created or destroyed, never mutated) — so it is defined directly with `updatedAt: false` rather
 * than through the shared base options that always add `updated_at`. Tenant-scoped + RLS.
 *
 * Co-located in user-management (the tenant-admin owner of the tags catalog); the finance services
 * read/write this join through their own access path in a later wave (the cross-service list filters).
 */
export function defineRecordTag(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.RecordTags,
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      record_type: { type: DataTypes.STRING, allowNull: false },
      record_id: { type: DataTypes.UUID, allowNull: false },
      tag_id: { type: DataTypes.UUID, allowNull: false },
      source: { type: DataTypes.STRING, allowNull: true },
      added_by: { type: DataTypes.UUID, allowNull: true },
    },
    {
      tableName: TableName.RecordTags,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false, // append-only join
    },
  );
}
