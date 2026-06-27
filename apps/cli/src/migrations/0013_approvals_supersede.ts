import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';

/**
 * W3-06 unified vote ledger — give `record_approvers` a live/superseded notion so the resolved chain
 * can be re-resolved or an approver reassigned WITHOUT losing the who-was-asked history.
 *
 * - `is_active` (default true): the LIVE chain is `WHERE is_active`; a reassignment / level
 *   re-resolution retires the prior slot by flipping it false (status `superseded`).
 * - `superseded_by_id`: audit back-pointer from a retired slot to the slot that replaced it.
 *
 * The original `(tenant, record, level, approver)` UNIQUE index is replaced by a PARTIAL unique
 * index scoped to live rows (`WHERE is_active`), so the SAME approver can reappear at the same level
 * across a supersede (one retired row + one live row) while a tenant still cannot have two LIVE
 * slots for the same approver+level. The `approvals` ledger is untouched (it stays append-only and
 * immutable — history lives there and in the retired chain rows).
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.addColumn(TableName.RecordApprovers, 'is_active', {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  });
  await q.addColumn(TableName.RecordApprovers, 'superseded_by_id', {
    type: DataTypes.UUID,
    allowNull: true,
  });

  // Swap the full unique index for a partial one scoped to the live chain.
  await q.removeIndex(TableName.RecordApprovers, 'record_approvers_record_level_approver_uq');
  await q.addIndex(
    TableName.RecordApprovers,
    ['tenant_id', 'record_type', 'record_id', 'level', 'approver_id'],
    {
      unique: true,
      name: 'record_approvers_live_record_level_approver_uq',
      where: { is_active: true },
    },
  );
  // Fast lookup of the live chain for a record.
  await q.addIndex(TableName.RecordApprovers, ['tenant_id', 'record_type', 'record_id', 'is_active'], {
    name: 'record_approvers_record_active_idx',
  });
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.removeIndex(TableName.RecordApprovers, 'record_approvers_record_active_idx');
  await q.removeIndex(TableName.RecordApprovers, 'record_approvers_live_record_level_approver_uq');
  await q.addIndex(
    TableName.RecordApprovers,
    ['tenant_id', 'record_type', 'record_id', 'level', 'approver_id'],
    { unique: true, name: 'record_approvers_record_level_approver_uq' },
  );
  await q.removeColumn(TableName.RecordApprovers, 'superseded_by_id');
  await q.removeColumn(TableName.RecordApprovers, 'is_active');
}
