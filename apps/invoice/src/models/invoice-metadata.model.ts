import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, InvoiceTransactionType } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `invoice_metadata` table — the 1:1 extracted/normalized header fields for an invoice
 * (`invoice_id` unique). Tenant-scoped (RLS); money in integer minor units.
 */
export function defineInvoiceMetadata(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.InvoiceMetadata,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      invoice_id: { type: DataTypes.UUID, allowNull: false, unique: true },
      invoice_number: { type: DataTypes.STRING, allowNull: false },
      invoice_date: { type: DataTypes.DATEONLY, allowNull: false },
      due_date: { type: DataTypes.DATEONLY, allowNull: true },
      transaction_type: { type: DataTypes.STRING, allowNull: false, defaultValue: InvoiceTransactionType.Debit },
      amount_minor: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.InvoiceMetadata, ...baseModelOptions },
  );
}
