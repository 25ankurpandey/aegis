import { DataTypes, type ModelStatic, type Model } from 'sequelize';
import type { ModelRegistry } from '@aegis/db';
import { TableName, ApproverGroupMemberType } from '@aegis/shared-enums';

/**
 * Defines the `approver_group_members` table — polymorphic membership of an approver group. A
 * member is either a concrete `user` or a `role` (satisfied by any holder), discriminated by
 * `member_type` with the principal id in `member_id`. Tenant-scoped + RLS.
 */
export function defineApproverGroupMember(registry: ModelRegistry): ModelStatic<Model> {
  return registry.define({
    tableName: TableName.ApproverGroupMembers,
    attributes: {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      group_id: { type: DataTypes.UUID, allowNull: false },
      member_type: { type: DataTypes.STRING, allowNull: false, defaultValue: ApproverGroupMemberType.User },
      member_id: { type: DataTypes.UUID, allowNull: false },
    },
  });
}
