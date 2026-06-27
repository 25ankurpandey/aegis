import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, PaymentStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `payment_batches` table (one disbursement batch per pay-run). */
export function definePaymentBatch(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.PaymentBatches,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      pay_run_id: { type: DataTypes.UUID, allowNull: false },
      file_ref: { type: DataTypes.STRING, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: PaymentStatus.Pending },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.PaymentBatches, ...baseModelOptions },
  );
}
