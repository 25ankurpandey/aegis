import { DataTypes, type ModelStatic, type Model } from 'sequelize';
import type { ModelRegistry } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

/**
 * Defines the `approval_hierarchy` table — one tenant manager/reporting edge per user (`user_id →
 * manager_id`, with `depth` from the org root). The manager-based resolver walks this to inject a
 * submitter's reporting manager as a dynamic approver level. Tenant-scoped + RLS.
 */
export function defineApprovalHierarchy(registry: ModelRegistry): ModelStatic<Model> {
  return registry.define({
    tableName: TableName.ApprovalHierarchy,
    attributes: {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      manager_id: { type: DataTypes.UUID, allowNull: true },
      depth: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
  });
}
