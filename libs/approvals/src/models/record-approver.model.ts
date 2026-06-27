import { DataTypes, type ModelStatic, type Model } from 'sequelize';
import type { ModelRegistry } from '@aegis/db';
import { TableName, ApproverType, RecordApproverStatus } from '@aegis/shared-enums';

/**
 * Defines the `record_approvers` table — the resolved approver chain materialised for ONE record
 * instance (the per-record routing snapshot). Each row is one slot: `(level, sequence)` ordering, a
 * polymorphic `(approver_type, approver_id)` target, and a `status` the engine advances. Snapshotting
 * the chain means a mid-flight policy edit cannot silently re-route an in-progress approval.
 * Tenant-scoped + RLS.
 */
export function defineRecordApprover(registry: ModelRegistry): ModelStatic<Model> {
  return registry.define({
    tableName: TableName.RecordApprovers,
    attributes: {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      record_type: { type: DataTypes.STRING, allowNull: false },
      record_id: { type: DataTypes.UUID, allowNull: false },
      level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      approver_type: { type: DataTypes.STRING, allowNull: false, defaultValue: ApproverType.User },
      approver_id: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: RecordApproverStatus.Pending },
      sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // W3-06 unified vote ledger: the live chain is `WHERE is_active`; a reassignment /
      // re-resolution flips the prior slot to is_active=false (status `superseded`) and points
      // `superseded_by_id` at its replacement so the full who-was-asked history is preserved.
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      superseded_by_id: { type: DataTypes.UUID, allowNull: true },
    },
  });
}
