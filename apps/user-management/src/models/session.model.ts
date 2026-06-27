import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { SessionStatus, TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines issued-token session rows so reference-IdP sessions can be listed and revoked. */
export function defineSession(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Sessions,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      jti: { type: DataTypes.STRING, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: SessionStatus.Active },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.Sessions, ...baseModelOptions },
  );
}
