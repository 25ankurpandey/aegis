import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `rule_audit_logs` table (one immutable verdict per rule execution; append-only). */
export function defineRuleAuditLog(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.RuleAuditLogs,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      rule_id: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false },
      detail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: TableName.RuleAuditLogs, ...baseModelOptions, updatedAt: false },
  );
}
