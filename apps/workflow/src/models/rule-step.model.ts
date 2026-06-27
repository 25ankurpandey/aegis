import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/** Defines the `rule_steps` table (an ordered condition group; `query` is a Predicate[] JSONB array). */
export function defineRuleStep(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.RuleSteps,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      rule_id: { type: DataTypes.UUID, allowNull: false },
      order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      query: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    { tableName: TableName.RuleSteps, ...baseModelOptions },
  );
}
