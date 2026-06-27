import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, InvoiceDuplicateStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `invoice_duplicates` table — a record written when header-level duplicate detection
 * flags an invoice as a likely copy of a prior one (`duplicate_of`). Tenant-scoped (RLS).
 */
export function defineInvoiceDuplicate(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.InvoiceDuplicates,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      invoice_id: { type: DataTypes.UUID, allowNull: false },
      duplicate_of: { type: DataTypes.UUID, allowNull: false },
      signature: { type: DataTypes.STRING, allowNull: false },
      reason: { type: DataTypes.STRING, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: InvoiceDuplicateStatus.Flagged },
      resolved_by: { type: DataTypes.UUID, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.InvoiceDuplicates, ...baseModelOptions },
  );
}
