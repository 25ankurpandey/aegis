import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, PayFrequency } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `pay_calendars` table (per-tenant period/cutoff/pay-date rules). */
export function definePayCalendar(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.PayCalendars,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      name: { type: DataTypes.STRING, allowNull: false },
      frequency: { type: DataTypes.STRING, allowNull: false, defaultValue: PayFrequency.Monthly },
      period_start_rule: { type: DataTypes.STRING, allowNull: true },
      cutoff_rule: { type: DataTypes.STRING, allowNull: true },
      pay_date_rule: { type: DataTypes.STRING, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.PayCalendars, ...baseModelOptions, paranoid: true, deletedAt: 'deleted_at' },
  );
}
