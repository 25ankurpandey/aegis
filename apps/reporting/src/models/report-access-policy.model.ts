import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `report_access_policies` table — the per-role column-masking obligation (§5.2) plus the
 * optional row filter. A run projects only `allowed_columns`, redacts `masked_columns`, and applies
 * `row_filter`; tenant-scoped and RLS-guarded.
 */
export function defineReportAccessPolicy(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ReportAccessPolicies,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      role: { type: DataTypes.STRING, allowNull: false },
      // columns this role may see / must have redacted (the column-masking obligation, §5.2)
      allowed_columns: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      masked_columns: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      row_filter: { type: DataTypes.TEXT, allowNull: true },
      // Audit columns — access policies are mutable configuration.
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.ReportAccessPolicies, ...baseModelOptions },
  );
}
