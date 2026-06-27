import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * Wave-6 B1 (catalog half) — the tenant `tags` catalog + `team_tags` mapping.
 *
 * `tags` is the per-tenant catalog of legal classification labels (mirrors `expense_categories`):
 * without it, tags were unvalidated free-strings in a JSONB blob — un-renameable, un-governable,
 * un-filterable. `team_tags` maps which catalog tags a team may use (donor's `0128_team_tags`).
 * The polymorphic record↔tag join (`record_tags`) is created by 0025 once `tags` exists.
 *
 * Both tenant-scoped + FORCE/RESTRICTIVE RLS. `tags` is a long-lived master entity → audited +
 * paranoid soft-delete with a case-insensitive partial-unique (tenant_id, lower(name)) on LIVE rows
 * (a tag name frees after soft-delete). `team_tags` is a join (no soft-delete).
 */

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};
const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
};
const audit = {
  created_by: { type: DataTypes.UUID, allowNull: true },
  updated_by: { type: DataTypes.UUID, allowNull: true },
};
const softDelete = {
  deleted_at: { type: DataTypes.DATE, allowNull: true },
};
const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // tags — per-tenant catalog of classification labels.
  await q.createTable(TableName.Tags, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    color: { type: DataTypes.STRING(16), allowNull: true }, // optional UI hint
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...audit,
    ...softDelete,
    ...timestamps,
  });
  // Case-insensitive partial-unique on the natural key, LIVE rows only ("Travel" == "travel"; a name
  // frees after soft-delete). Expression index → raw SQL.
  await q.sequelize.query(
    'CREATE UNIQUE INDEX "tags_tenant_name_uq" ON "tags" ("tenant_id", lower("name")) WHERE "deleted_at" IS NULL',
  );
  // Recency-ordered tenant listing (the tag list view).
  await q.addIndex(TableName.Tags, ['tenant_id', 'created_at'], {
    name: 'tags_tenant_created_idx',
  });

  // team_tags — which catalog tags a team may apply.
  await q.createTable(TableName.TeamTags, {
    id: uuidPk,
    tenant_id: tenantFk,
    team_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.Teams, key: 'id' },
      onDelete: 'CASCADE',
    },
    tag_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.Tags, key: 'id' },
      onDelete: 'CASCADE',
    },
    ...timestamps,
  });
  // A (team, tag) pair maps at most once (the mapping natural key). Not paranoid → plain unique.
  await q.addIndex(TableName.TeamTags, ['tenant_id', 'team_id', 'tag_id'], {
    unique: true,
    name: 'team_tags_tenant_team_tag_uq',
  });
  // "tags for this team" and "teams using this tag" lookups.
  await q.addIndex(TableName.TeamTags, ['tenant_id', 'tag_id'], {
    name: 'team_tags_tenant_tag_idx',
  });

  // Row-Level Security (tenant_id keyed, FORCE + RESTRICTIVE) on both tables.
  const stmts = [...rlsPolicyStatements(TableName.Tags), ...rlsPolicyStatements(TableName.TeamTags)];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.TeamTags);
  await q.dropTable(TableName.Tags);
}
