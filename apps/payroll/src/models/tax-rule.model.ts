import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { baseModelOptions } from '@aegis/db';
import { TableName } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

/**
 * Defines the `tax_rules` table. `tenant_id` is NULLABLE: a null row is a platform-default rule;
 * a set row is tenant-specific (effective-dated + versioned).
 */
export function defineTaxRule(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.TaxRules,
    {
      id: uuidPk,
      tenant_id: { type: DataTypes.UUID, allowNull: true },
      jurisdiction: { type: DataTypes.STRING, allowNull: false },
      rule_type: { type: DataTypes.STRING, allowNull: false },
      effective_from: { type: DataTypes.DATEONLY, allowNull: false },
      effective_to: { type: DataTypes.DATEONLY, allowNull: true },
      params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: TableName.TaxRules, ...baseModelOptions, paranoid: true, deletedAt: 'deleted_at' },
  );
}
