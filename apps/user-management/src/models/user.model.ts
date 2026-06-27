import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { modelOptions } from '@aegis/db';
import { TableName, UserStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `users` table (tenant-scoped; password stored as a scrypt hash). */
export function defineUser(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Users,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: false },
      first_name: { type: DataTypes.STRING },
      last_name: { type: DataTypes.STRING },
      password_hash: { type: DataTypes.STRING, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: UserStatus.Active },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    // Optimistic locking (`lock_version`) guards concurrent profile/status edits.
    { tableName: TableName.Users, ...modelOptions({ paranoid: true, version: true }) },
  );
}
