import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `notifications` table (the tenant-scoped in-app inbox; message stored as JSONB). */
export function defineNotification(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Notifications,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.STRING, allowNull: false },
      message: { type: DataTypes.JSONB, allowNull: false },
      correlation_id: { type: DataTypes.STRING, allowNull: true },
      read_at: { type: DataTypes.DATE, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.Notifications, ...baseModelOptions },
  );
}
