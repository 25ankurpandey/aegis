import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * Wave-6 B2 — create the missing `teams` / `team_members` tables.
 *
 * `TableName.Teams` / `TableName.TeamMembers` were declared in the enum but NEVER migrated, so the
 * `team_id` column 0022 bolted onto the finance aggregates (and the workflow `assign_team` action)
 * pointed at a table that did not exist. This creates the real catalog + membership tables; the FK
 * from `expense_reports`/`invoices`/`pay_runs`.team_id → teams.id is added later by 0025 (once both
 * teams AND record_tags exist). Tenant-admin (user-management) owns team CRUD.
 *
 * Both tables are tenant-scoped (tenant_id NOT NULL) + FORCE/RESTRICTIVE RLS. `teams` is a long-lived
 * master entity → audited + paranoid soft-delete; partial-unique (tenant_id, lower(name)) on LIVE
 * rows only so a team name frees up after soft-delete. `team_members` is a join (no soft-delete).
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
  // teams — per-tenant catalog of teams a record can be assigned to.
  await q.createTable(TableName.Teams, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.STRING, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...audit,
    ...softDelete,
    ...timestamps,
  });
  // Case-insensitive partial-unique on the natural key, LIVE rows only ("Finance" == "finance";
  // a name frees after soft-delete). Expression index → raw SQL (addIndex can't do lower(name)).
  await q.sequelize.query(
    'CREATE UNIQUE INDEX "teams_tenant_name_uq" ON "teams" ("tenant_id", lower("name")) WHERE "deleted_at" IS NULL',
  );
  // Recency-ordered tenant listing (the team list view).
  await q.addIndex(TableName.Teams, ['tenant_id', 'created_at'], {
    name: 'teams_tenant_created_idx',
  });

  // team_members — which users belong to a team (and in what role).
  await q.createTable(TableName.TeamMembers, {
    id: uuidPk,
    tenant_id: tenantFk,
    team_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.Teams, key: 'id' },
      onDelete: 'CASCADE',
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.Users, key: 'id' },
      onDelete: 'CASCADE',
    },
    role: { type: DataTypes.STRING, allowNull: true },
    ...timestamps,
  });
  // A user appears at most once in a team (the membership natural key). Not paranoid → plain unique.
  await q.addIndex(TableName.TeamMembers, ['team_id', 'user_id'], {
    unique: true,
    name: 'team_members_team_user_uq',
  });
  // "members of this team" and "teams for this user" lookups.
  await q.addIndex(TableName.TeamMembers, ['tenant_id', 'team_id'], {
    name: 'team_members_tenant_team_idx',
  });
  await q.addIndex(TableName.TeamMembers, ['tenant_id', 'user_id'], {
    name: 'team_members_tenant_user_idx',
  });

  // Row-Level Security (tenant_id keyed, FORCE + RESTRICTIVE) on both tables.
  const stmts = [...rlsPolicyStatements(TableName.Teams), ...rlsPolicyStatements(TableName.TeamMembers)];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.TeamMembers);
  await q.dropTable(TableName.Teams);
}
