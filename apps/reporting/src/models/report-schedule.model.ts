import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `report_schedules` table (cron-driven recurring runs of a definition; tenant-scoped). */
export function defineReportSchedule(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ReportSchedules,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      definition_id: { type: DataTypes.UUID, allowNull: false },
      cron: { type: DataTypes.STRING, allowNull: false },
      timezone: { type: DataTypes.STRING, allowNull: false, defaultValue: 'UTC' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      // Audit columns — schedules are mutable configuration.
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.ReportSchedules, ...baseModelOptions },
  );
}
