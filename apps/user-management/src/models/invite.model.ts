import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { InviteStatus, Scope, TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines tenant-scoped invitations issued by user-management. */
export function defineInvite(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Invites,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: false },
      token_hash: { type: DataTypes.STRING, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: InviteStatus.Pending },
      role_id: { type: DataTypes.UUID, allowNull: true },
      scope: { type: DataTypes.STRING, allowNull: false, defaultValue: Scope.OwnOnly },
      team_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      accepted_at: { type: DataTypes.DATE, allowNull: true },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.Invites, ...baseModelOptions },
  );
}
