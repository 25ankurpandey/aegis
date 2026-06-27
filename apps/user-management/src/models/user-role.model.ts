import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `user_roles` table (tenant-scoped; carries the user's row-level `scope`). */
export function defineUserRole(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.UserRoles,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      role_id: { type: DataTypes.UUID, allowNull: false },
      scope: { type: DataTypes.STRING, allowNull: false, defaultValue: 'own_only' },
    },
    { tableName: TableName.UserRoles, ...baseModelOptions },
  );
}
