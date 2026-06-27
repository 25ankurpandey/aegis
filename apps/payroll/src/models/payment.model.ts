import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName, PaymentStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `payments` table (one idempotent disbursement per payslip, keyed by `idempotency_key`). */
export function definePayment(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Payments,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      payslip_id: { type: DataTypes.UUID, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: true },
      amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: PaymentStatus.Pending },
      idempotency_key: { type: DataTypes.STRING, allowNull: false, unique: true },
      rail_ref: { type: DataTypes.STRING, allowNull: true },
    },
    { tableName: TableName.Payments, ...baseModelOptions },
  );
}
