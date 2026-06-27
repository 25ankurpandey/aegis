import { DataTypes, type ModelStatic, type Model } from 'sequelize';
import type { ModelRegistry } from '@aegis/db';
import { TableName, ApprovalMode } from '@aegis/shared-enums';

/**
 * Defines the `approval_policies` table — a per-tenant policy describing HOW a record TYPE is
 * approved (`mode`, `min_approvals`, plus a `config` JSONB extension seam). Tenant-scoped + RLS +
 * soft-delete (a retired policy must survive for historical chains that resolved against it).
 */
export function defineApprovalPolicy(registry: ModelRegistry): ModelStatic<Model> {
  return registry.define({
    tableName: TableName.ApprovalPolicies,
    paranoid: true,
    attributes: {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      record_type: { type: DataTypes.STRING, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      mode: { type: DataTypes.STRING, allowNull: false, defaultValue: ApprovalMode.Sequential },
      min_approvals: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
  });
}
