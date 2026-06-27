import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { modelOptions } from '@aegis/db';
import { TableName, PayRunStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/**
 * Defines the `pay_runs` table — the lifecycle aggregate root. `locked_snapshot` captures the
 * computed result at approval so a run can never be silently recomputed (Draft → Calculated →
 * Approved → Paid, with maker-checker enforced at approve).
 */
export function definePayRun(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.PayRuns,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      pay_calendar_id: { type: DataTypes.UUID, allowNull: true },
      period_start: { type: DataTypes.DATEONLY, allowNull: false },
      period_end: { type: DataTypes.DATEONLY, allowNull: false },
      pay_date: { type: DataTypes.DATEONLY, allowNull: false },
      type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'regular' },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: PayRunStatus.Draft },
      // Workflow-rule annotations (assign_team / add_tag): owning team + classification tags applied by
      // the engine's RecordUpdated follow-on. Nullable — most pay runs carry neither.
      team_id: { type: DataTypes.UUID, allowNull: true },
      assignee_id: { type: DataTypes.UUID, allowNull: true },
      tags: { type: DataTypes.JSONB, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: false },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      approved_by: { type: DataTypes.UUID, allowNull: true },
      approved_at: { type: DataTypes.DATE, allowNull: true },
      locked_snapshot: { type: DataTypes.JSONB, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    // Optimistic locking (`lock_version`) guards the maker-checker status machine against lost
    // updates when calculate/approve/pay race; paranoid soft-delete via `deleted_at`.
    { tableName: TableName.PayRuns, ...modelOptions({ paranoid: true, version: true }) },
  );
}
