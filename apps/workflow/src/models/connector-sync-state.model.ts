import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `connector_sync_state` table (migration 0020) — the durable record of each ERP push:
 * one tenant-scoped row per (tenant, idempotency_key) carrying the lifecycle status, ERP external id,
 * attempt count, and last error. Backs {@link DbSyncStateStore} so BaseConnector's idempotency +
 * reconcile survive restarts / replica fan-out (the in-memory Map could not). RLS is enforced by the
 * migration's tenant-isolation policy; every access goes through `withTenantTransaction`.
 */
export function defineConnectorSyncState(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.ConnectorSyncState,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      kind: { type: DataTypes.STRING, allowNull: false },
      entity: { type: DataTypes.STRING, allowNull: false },
      record_id: { type: DataTypes.STRING, allowNull: false },
      idempotency_key: { type: DataTypes.STRING, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'in_progress' },
      external_id: { type: DataTypes.STRING, allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_error: { type: DataTypes.TEXT, allowNull: true },
    },
    { tableName: TableName.ConnectorSyncState, ...baseModelOptions },
  );
}
