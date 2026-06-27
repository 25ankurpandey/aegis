import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `team_tags` table (which catalog tags a team may apply; tenant-scoped + RLS). */
export function defineTeamTag(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.TeamTags,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      team_id: { type: DataTypes.UUID, allowNull: false },
      tag_id: { type: DataTypes.UUID, allowNull: false },
    },
    { tableName: TableName.TeamTags, ...baseModelOptions },
  );
}
