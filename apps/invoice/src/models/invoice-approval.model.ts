import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `invoice_approvals` table — an approval vote in the (possibly multi-level) chain
 * (`approval_level` + `decision`). Tenant-scoped (RLS).
 */
export function defineInvoiceApproval(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.InvoiceApprovals,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      invoice_id: { type: DataTypes.UUID, allowNull: false },
      approver_id: { type: DataTypes.UUID, allowNull: false },
      approval_level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      decision: { type: DataTypes.STRING, allowNull: false },
      comment: { type: DataTypes.STRING, allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.InvoiceApprovals, ...baseModelOptions },
  );
}
