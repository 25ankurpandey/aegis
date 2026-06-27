import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';

/**
 * BUG-0003 — WORKFLOW `assign_team` / `add_tag` LAND ON THE RECORD. The engine's builtin actions
 * publish `EventTopic.RecordUpdated` carrying `teamId` / `tags`; before BUG-0003 no service consumed
 * it, so the actions reported success while the write silently never happened. The owning finance
 * services now consume RecordUpdated and persist the annotation onto their own aggregate. This adds the
 * backing columns to the three targetable aggregates (expense_report / invoice / pay_run):
 *   - `team_id` (UUID, nullable) — owning team set by `assign_team`.
 *   - `tags`    (JSONB, nullable) — classification tags unioned by `add_tag`.
 * Additive + nullable + idempotent (each column added only when absent).
 */

const TABLES = [TableName.ExpenseReports, TableName.Invoices, TableName.PayRuns] as const;
const TEAM_COL = 'team_id';
const TAGS_COL = 'tags';

async function hasColumn(q: QueryInterface, table: string, column: string): Promise<boolean> {
  const cols = await q.describeTable(table);
  return Object.prototype.hasOwnProperty.call(cols, column);
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  for (const table of TABLES) {
    if (!(await hasColumn(q, table, TEAM_COL))) {
      await q.addColumn(table, TEAM_COL, { type: DataTypes.UUID, allowNull: true });
    }
    if (!(await hasColumn(q, table, TAGS_COL))) {
      await q.addColumn(table, TAGS_COL, { type: DataTypes.JSONB, allowNull: true });
    }
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  for (const table of TABLES) {
    if (await hasColumn(q, table, TAGS_COL)) await q.removeColumn(table, TAGS_COL);
    if (await hasColumn(q, table, TEAM_COL)) await q.removeColumn(table, TEAM_COL);
  }
}
