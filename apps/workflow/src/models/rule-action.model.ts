import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `rule_actions` table (a typed side-effect with free-form `config` JSONB). */
export function defineRuleAction(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.RuleActions,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      rule_id: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING, allowNull: false },
      config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.RuleActions, ...baseModelOptions },
  );
}
