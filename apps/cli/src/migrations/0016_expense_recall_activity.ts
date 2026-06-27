import type { QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName, ExpenseActivityType } from '@aegis/shared-enums';

/**
 * Widen the `expense_activities_type_check` CHECK constraint to admit the new `report_recalled`
 * activity type (W3-13c RECALL). The original constraint (0003_expense) snapshotted the activity-type
 * set at author time, so a freshly-added enum value would be rejected at INSERT until the constraint
 * is re-issued from the current `ExpenseActivityType` set. This migration drops and re-adds the check
 * with the full, up-to-date value set — purely additive (every previously-valid value stays valid).
 */

const TABLE = TableName.ExpenseActivities;
const CONSTRAINT = 'expense_activities_type_check';

/** `CHECK (activity_type IN (...))` over the given values. */
function activityTypeCheck(values: readonly string[]): string {
  const list = values.map((v) => `'${v}'`).join(', ');
  return `ALTER TABLE "${TABLE}" ADD CONSTRAINT "${CONSTRAINT}" CHECK ("activity_type" IN (${list}))`;
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);
  // Re-add from the CURRENT enum set (now including report_recalled).
  await q.sequelize.query(activityTypeCheck(Object.values(ExpenseActivityType)));
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);
  // Restore the pre-recall value set (everything except report_recalled).
  const prior = Object.values(ExpenseActivityType).filter(
    (v) => v !== ExpenseActivityType.ReportRecalled,
  );
  await q.sequelize.query(activityTypeCheck(prior));
}
