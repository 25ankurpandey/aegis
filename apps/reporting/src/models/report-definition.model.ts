import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `report_definitions` table — a declarative report (tenant-scoped, RLS-guarded). The
 * `spec` is data ({ measures[], dimensions[], filters[], grain, source }), compiled against the read
 * model later; it is never raw SQL from clients.
 */
export function defineReportDefinition(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ReportDefinitions,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      // { measures[], dimensions[], filters[], grain, source }
      spec: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      required_permission: { type: DataTypes.STRING, allowNull: false },
      created_by: { type: DataTypes.UUID, allowNull: false },
      // Audit: last mutator (nullable — null until first update).
      updated_by: { type: DataTypes.UUID, allowNull: true },
      // Soft-delete tombstone (paranoid: true below maps Sequelize's deletedAt → this column).
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    // report_definitions is a long-lived master entity → paranoid soft-delete.
    { tableName: TableName.ReportDefinitions, paranoid: true, deletedAt: 'deleted_at', ...baseModelOptions },
  );
}
