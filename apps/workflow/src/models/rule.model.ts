import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { modelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `rules` table (tenant-scoped; one rule = a trigger event + its steps + actions). */
export function defineRule(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Rules,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      event: { type: DataTypes.STRING, allowNull: false },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      last_run: { type: DataTypes.DATE, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    // Long-lived aggregate root → soft-delete (paranoid) + audit attribution columns + optimistic
    // locking (`lock_version`) so concurrent rule edits don't silently clobber one another.
    { tableName: TableName.Rules, ...modelOptions({ paranoid: true, version: true }) },
  );
}
