import { DataTypes, type ModelStatic, type Model } from 'sequelize';
import type { ModelRegistry } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

/**
 * Defines the `approver_groups` table — a named group an approver level can route to (any member
 * can clear the level). Tenant-scoped + RLS + soft-delete (a retired group must survive for
 * historical chains routed through it).
 */
export function defineApproverGroup(registry: ModelRegistry): ModelStatic<Model> {
  return registry.define({
    tableName: TableName.ApproverGroups,
    paranoid: true,
    attributes: {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
  });
}
