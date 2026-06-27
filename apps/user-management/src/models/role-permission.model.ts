import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `role_permissions` join table (role ⇄ permission, many-to-many). */
export function defineRolePermission(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.RolePermissions,
    {
      id: uuidPk,
      role_id: { type: DataTypes.UUID, allowNull: false },
      permission_id: { type: DataTypes.UUID, allowNull: false },
    },
    { tableName: TableName.RolePermissions, ...baseModelOptions },
  );
}
