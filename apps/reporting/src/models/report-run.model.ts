import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, ReportRunStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `report_runs` table — the asynchronous run lifecycle (tenant-scoped, RLS-guarded).
 * Status is a plain string: queued | running | succeeded | failed (see docs/services/reporting.md §9).
 */
export function defineReportRun(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ReportRuns,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      definition_id: { type: DataTypes.UUID, allowNull: false },
      requested_by: { type: DataTypes.UUID, allowNull: false },
      params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // queued | running | succeeded | failed (plain strings — see docs/services/reporting.md §9)
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: ReportRunStatus.Queued },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      artifact_url: { type: DataTypes.STRING, allowNull: true },
      error: { type: DataTypes.TEXT, allowNull: true },
    },
    { tableName: TableName.ReportRuns, ...baseModelOptions },
  );
}
