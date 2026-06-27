import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName, ApprovalRecordType } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * Wave-6 B1 (join half) + B2 (team FK) + B3 (assignee) — record-level annotation foundation.
 *
 *  1. `record_tags` — the polymorphic record↔tag join, ONE table for all three finance record types,
 *     keyed by `record_type` (an `ApprovalRecordType` value: expense_report | invoice | pay_run).
 *     A real join with a catalog FK + provenance (`source`, `added_by`), replacing the free-string
 *     `tags` JSONB. Chosen over per-service joins because it reuses `ApprovalRecordType` (already
 *     spans the three services) and keeps one filter/condition implementation (donor's `job_tags`).
 *  2. ALTER `expense_reports`/`invoices`/`pay_runs`:
 *       - ADD `assignee_id` UUID NULL → users.id (B3 owner; the creator stays `submitter_id`).
 *       - ADD the FK `team_id` → teams.id (0022 added the bare UUID column; now that 0023 created
 *         `teams`, wire the real constraint and close the dangling reference).
 *
 * `record_tags` is tenant-scoped + FORCE/RESTRICTIVE RLS; cross-record-type isolation by `record_type`.
 * Append-only join → no soft-delete / lock_version. `record_type` constrained to the enum.
 */

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};
const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};

const ANNOTATED = [TableName.ExpenseReports, TableName.Invoices, TableName.PayRuns] as const;
const ASSIGNEE_COL = 'assignee_id';
const TEAM_COL = 'team_id';

async function hasColumn(q: QueryInterface, table: string, column: string): Promise<boolean> {
  const cols = await q.describeTable(table);
  return Object.prototype.hasOwnProperty.call(cols, column);
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // record_tags — polymorphic record↔tag join.
  await q.createTable(TableName.RecordTags, {
    id: uuidPk,
    tenant_id: tenantFk,
    record_type: { type: DataTypes.STRING, allowNull: false },
    record_id: { type: DataTypes.UUID, allowNull: false },
    tag_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.Tags, key: 'id' },
      onDelete: 'CASCADE',
    },
    source: { type: DataTypes.STRING(32), allowNull: true }, // 'manual' | 'workflow' | 'import'
    added_by: { type: DataTypes.UUID, allowNull: true }, // provenance
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('now()'),
    },
  });
  // A tag is attached to a given record at most once (the join natural key).
  await q.addIndex(TableName.RecordTags, ['tenant_id', 'record_type', 'record_id', 'tag_id'], {
    unique: true,
    name: 'record_tags_tenant_record_tag_uq',
  });
  // "list records carrying tag X" (the tag filter join).
  await q.addIndex(TableName.RecordTags, ['tenant_id', 'tag_id'], {
    name: 'record_tags_tenant_tag_idx',
  });
  // "tags on this record" (the per-record fetch + the assemble-facts path).
  await q.addIndex(TableName.RecordTags, ['tenant_id', 'record_type', 'record_id'], {
    name: 'record_tags_tenant_record_idx',
  });
  // record_type constrained to the shared approval record-type enum.
  await q.addConstraint(TableName.RecordTags, {
    type: 'check',
    fields: ['record_type'],
    name: 'record_tags_record_type_check',
    where: { record_type: Object.values(ApprovalRecordType) },
  });

  // ALTER the three annotated aggregates: add assignee_id (B3) + the real team_id FK (B2).
  for (const table of ANNOTATED) {
    if (!(await hasColumn(q, table, ASSIGNEE_COL))) {
      await q.addColumn(table, ASSIGNEE_COL, {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: TableName.Users, key: 'id' },
        onDelete: 'SET NULL',
      });
    }
    // "my queue" — records assigned to a given user within the tenant.
    await q.addIndex(table, ['tenant_id', ASSIGNEE_COL], {
      name: `${table}_tenant_assignee_idx`,
    });
    // The team_id column already exists (0022) as a bare UUID; add the FK now that teams exists.
    await q.addConstraint(table, {
      type: 'foreign key',
      fields: [TEAM_COL],
      name: `${table}_team_id_fkey`,
      references: { table: TableName.Teams, field: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    // Team filtering ("records owned by team X").
    await q.addIndex(table, ['tenant_id', TEAM_COL], {
      name: `${table}_tenant_team_idx`,
    });
  }

  // Row-Level Security (tenant_id keyed, FORCE + RESTRICTIVE) on the new join.
  for (const stmt of rlsPolicyStatements(TableName.RecordTags)) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  for (const table of ANNOTATED) {
    await q.removeConstraint(table, `${table}_team_id_fkey`).catch(() => undefined);
    await q.removeIndex(table, `${table}_tenant_team_idx`).catch(() => undefined);
    await q.removeIndex(table, `${table}_tenant_assignee_idx`).catch(() => undefined);
    if (await hasColumn(q, table, ASSIGNEE_COL)) await q.removeColumn(table, ASSIGNEE_COL);
  }
  await q.dropTable(TableName.RecordTags);
}
