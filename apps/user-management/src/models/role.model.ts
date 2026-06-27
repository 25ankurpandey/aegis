import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { modelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `roles` table. System roles have a null `tenant_id`; custom roles are tenant-scoped. */
export function defineRole(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Roles,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: true },
      name: { type: DataTypes.STRING, allowNull: false },
      description: { type: DataTypes.STRING },
      is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    // Optimistic locking (`lock_version`) guards concurrent edits to a role's grants/metadata.
    { tableName: TableName.Roles, ...modelOptions({ paranoid: true, version: true }) },
  );
}
