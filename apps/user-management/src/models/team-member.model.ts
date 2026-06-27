import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `team_members` table (which users belong to a team; tenant-scoped + RLS). */
export function defineTeamMember(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.TeamMembers,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      team_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      role: { type: DataTypes.STRING, allowNull: true },
    },
    { tableName: TableName.TeamMembers, ...baseModelOptions },
  );
}
