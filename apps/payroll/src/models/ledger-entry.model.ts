import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/**
 * Defines the `ledger_entries` table — an append-only double-entry GL. There is no update/delete
 * path; corrections post a reversal entry (`reversal_of`).
 */
export function defineLedgerEntry(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.LedgerEntries,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      pay_run_id: { type: DataTypes.UUID, allowNull: false },
      account: { type: DataTypes.STRING, allowNull: false },
      debit: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      credit: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
      reversal_of: { type: DataTypes.UUID, allowNull: true },
      posted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: TableName.LedgerEntries, ...baseModelOptions },
  );
}
