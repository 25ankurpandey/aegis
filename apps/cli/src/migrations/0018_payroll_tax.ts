import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';

/**
 * W5-05 — real tax resolution + pre-tax deductions.
 *
 * The pay-run engine must reduce the taxable base by *pre-tax* deductions and resolve statutory tax
 * from the effective-dated, jurisdiction-keyed `tax_rules` table (tax is data, not code). This
 * migration makes the schema able to express both:
 *
 *   1. A boolean **pre-tax flag** on `deduction_codes`. The original payroll schema (0005) already
 *      created this column as `pre_tax` (default false). To stay additive and never create a
 *      duplicate/ambiguous second column, we ADD `is_pre_tax` ONLY when no pre-tax flag exists yet;
 *      when `pre_tax` is already present we leave it as the canonical column. Either way the engine
 *      reads the flag through a single resolver (`deductionPreTaxFlag`), so the computation is correct
 *      regardless of which column name a given database carries.
 *
 *   2. A covering index that lets the tax resolver fetch the most-specific effective-dated rule for a
 *      `(jurisdiction, rule_type)` whose validity window contains the pay date in one scan
 *      (platform-default `tenant_id IS NULL` rows + tenant overrides are both reachable under RLS).
 */

const DEDUCTION_PRE_TAX_LEGACY = 'pre_tax';
const DEDUCTION_PRE_TAX_NEW = 'is_pre_tax';

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // Additive pre-tax flag. The 0005 schema seeded `pre_tax`; only add `is_pre_tax` if NEITHER flag
  // exists, so this migration is safe on both the seeded schema and a hypothetical fresh one.
  const deductionCols = await q.describeTable(TableName.DeductionCodes);
  const hasLegacy = Object.prototype.hasOwnProperty.call(deductionCols, DEDUCTION_PRE_TAX_LEGACY);
  const hasNew = Object.prototype.hasOwnProperty.call(deductionCols, DEDUCTION_PRE_TAX_NEW);
  if (!hasLegacy && !hasNew) {
    await q.addColumn(TableName.DeductionCodes, DEDUCTION_PRE_TAX_NEW, {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  }

  // Effective-dated tax resolution path. The base 0005 schema indexes (jurisdiction, rule_type);
  // extend it to include the validity-window lower bound so the resolver's
  // `WHERE jurisdiction = ? AND rule_type = ? AND effective_from <= :payDate` is index-served.
  const taxIndexes = (await q.showIndex(TableName.TaxRules)) as Array<{ name: string }>;
  const taxIndexName = 'tax_rules_jurisdiction_type_effective_idx';
  if (!taxIndexes.some((i) => i.name === taxIndexName)) {
    await q.addIndex(TableName.TaxRules, ['jurisdiction', 'rule_type', 'effective_from'], {
      name: taxIndexName,
    });
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const taxIndexName = 'tax_rules_jurisdiction_type_effective_idx';
  const taxIndexes = (await q.showIndex(TableName.TaxRules)) as Array<{ name: string }>;
  if (taxIndexes.some((i) => i.name === taxIndexName)) {
    await q.removeIndex(TableName.TaxRules, taxIndexName);
  }

  // Only drop the column this migration added (never the legacy `pre_tax` it may have left in place).
  const deductionCols = await q.describeTable(TableName.DeductionCodes);
  const hasLegacy = Object.prototype.hasOwnProperty.call(deductionCols, DEDUCTION_PRE_TAX_LEGACY);
  const hasNew = Object.prototype.hasOwnProperty.call(deductionCols, DEDUCTION_PRE_TAX_NEW);
  if (hasNew && !hasLegacy) {
    await q.removeColumn(TableName.DeductionCodes, DEDUCTION_PRE_TAX_NEW);
  }
}
