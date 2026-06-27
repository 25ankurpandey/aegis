import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName, UserStatus, Scope, TenantStatus } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};
const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
};
/** Mutable-entity audit columns (who created / last updated the row). Nullable: system seeds + back-fill. */
const auditCols = {
  created_by: { type: DataTypes.UUID, allowNull: true },
  updated_by: { type: DataTypes.UUID, allowNull: true },
};
/** Paranoid soft-delete column for long-lived master entities (Sequelize `paranoid: true`). */
const softDelete = {
  deleted_at: { type: DataTypes.DATE, allowNull: true },
};
/**
 * Optimistic-lock counter for mutable aggregate roots (Sequelize `version: 'lock_version'`).
 * Sequelize increments it on every UPDATE and guards with `WHERE lock_version = ?`, throwing
 * `OptimisticLockError` on a stale write. Named `lock_version` to avoid colliding with domain
 * effective-dating `version` columns elsewhere.
 */
const lockVersion = {
  lock_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
};
const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};

/** Allowed tenant lifecycle states (provisioning → active → suspended → cancelled). */
const TENANT_STATUSES = Object.values(TenantStatus);

/** SQL `IN (...)` value list helper for a CHECK over a string enum. */
function inList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

/**
 * Custom RLS for tables whose isolation key is not `tenant_id`.
 *
 * `withCheck` (optional) sets a DISTINCT write predicate. Postgres defaults WITH CHECK to the USING
 * predicate when omitted, which is too permissive for tables (like `roles`) whose USING intentionally
 * admits cross-cutting reads (global system rows) that a tenant session must NOT be allowed to WRITE
 * (BUG-0009). Pass an explicit, stricter `withCheck` for those.
 */
function customRls(table: string, predicate: string, withCheck?: string): string[] {
  const policy = `${table}_isolation`;
  const check = withCheck ? ` WITH CHECK (${withCheck})` : '';
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "${policy}" ON "${table}";`,
    `CREATE POLICY "${policy}" ON "${table}" AS RESTRICTIVE USING (${predicate})${check};`,
  ];
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TableName.Tenants, {
    id: uuidPk,
    name: { type: DataTypes.STRING, allowNull: false },
    slug: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    ...auditCols,
    ...timestamps,
    ...softDelete,
  });
  await q.addConstraint(TableName.Tenants, {
    type: 'check',
    name: 'tenants_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(TENANT_STATUSES)})`),
  });
  // A tenant slug is a global natural key, but `tenants` is paranoid (soft-delete): scope the
  // uniqueness to live rows so a slug can be reused once its tenant is soft-deleted (avoids 23505).
  await q.addIndex(TableName.Tenants, ['slug'], {
    name: 'tenants_slug_uq',
    unique: true,
    where: { deleted_at: null },
  });
  // Long-lived master entity: list/filter by lifecycle + recency.
  await q.addIndex(TableName.Tenants, ['status'], { name: 'tenants_status_idx' });
  await q.addIndex(TableName.Tenants, ['created_at'], { name: 'tenants_created_at_idx' });

  await q.createTable(TableName.Users, {
    id: uuidPk,
    tenant_id: tenantFk,
    email: { type: DataTypes.STRING, allowNull: false },
    first_name: { type: DataTypes.STRING },
    last_name: { type: DataTypes.STRING },
    password_hash: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    ...auditCols,
    ...timestamps,
    ...softDelete,
    ...lockVersion,
  });
  // `users` is paranoid (soft-delete): scope the (tenant_id, email) uniqueness to live rows so the
  // same email can be re-onboarded after a user is soft-deleted (avoids 23505 on recreate).
  await q.addIndex(TableName.Users, ['tenant_id', 'email'], {
    unique: true,
    name: 'users_tenant_email_uq',
    where: { deleted_at: null },
  });
  await q.addConstraint(TableName.Users, {
    type: 'check',
    name: 'users_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(Object.values(UserStatus))})`),
  });
  // Users are listed/filtered per tenant by status + recency.
  await q.addIndex(TableName.Users, ['tenant_id', 'status'], { name: 'users_tenant_status_idx' });
  await q.addIndex(TableName.Users, ['tenant_id', 'created_at'], { name: 'users_tenant_created_at_idx' });

  await q.createTable(TableName.Permissions, {
    id: uuidPk,
    name: { type: DataTypes.STRING, allowNull: false, unique: true },
    description: { type: DataTypes.STRING },
    ...auditCols,
    ...timestamps,
  });

  await q.createTable(TableName.Roles, {
    id: uuidPk,
    tenant_id: { type: DataTypes.UUID, allowNull: true, references: { model: TableName.Tenants, key: 'id' }, onDelete: 'CASCADE' },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.STRING },
    is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...auditCols,
    ...timestamps,
    ...softDelete,
    ...lockVersion,
  });
  await q.addIndex(TableName.Roles, ['tenant_id', 'name'], { name: 'roles_tenant_name_idx' });
  // A role name is a tenant-unique natural key. `roles` is paranoid (soft-delete) AND tenant_id is
  // nullable (NULL = a platform-wide system role), so we need two partial unique indexes:
  //  - tenant-scoped custom roles: unique (tenant_id, name) over live rows;
  //  - system roles (tenant_id IS NULL): unique (name) over live rows — Postgres treats NULL as
  //    distinct in a composite unique index, so the first index alone would not dedupe system roles.
  // Both are scoped to deleted_at IS NULL so a name can be reused after a soft-delete (avoids 23505).
  await q.addIndex(TableName.Roles, ['tenant_id', 'name'], {
    name: 'roles_tenant_name_uq',
    unique: true,
    where: { deleted_at: null },
  });
  await q.addIndex(TableName.Roles, ['name'], {
    name: 'roles_system_name_uq',
    unique: true,
    where: { tenant_id: null, deleted_at: null },
  });
  await q.addIndex(TableName.Roles, ['tenant_id', 'created_at'], { name: 'roles_tenant_created_at_idx' });

  await q.createTable(TableName.RolePermissions, {
    id: uuidPk,
    role_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Roles, key: 'id' }, onDelete: 'CASCADE' },
    permission_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Permissions, key: 'id' }, onDelete: 'CASCADE' },
    ...timestamps,
  });
  await q.addIndex(TableName.RolePermissions, ['role_id', 'permission_id'], { unique: true, name: 'role_perm_uq' });
  // FK index: role_perm_uq covers role_id; permission_id still needs its own index.
  await q.addIndex(TableName.RolePermissions, ['permission_id'], { name: 'role_perm_permission_idx' });

  await q.createTable(TableName.UserRoles, {
    id: uuidPk,
    tenant_id: tenantFk,
    user_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Users, key: 'id' }, onDelete: 'CASCADE' },
    role_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Roles, key: 'id' }, onDelete: 'CASCADE' },
    scope: { type: DataTypes.STRING, allowNull: false, defaultValue: 'own_only' },
    ...timestamps,
  });
  await q.addIndex(TableName.UserRoles, ['tenant_id', 'user_id'], { unique: true, name: 'user_roles_tenant_user_uq' });
  // FK index: the unique key covers (tenant_id, user_id); role_id still needs its own index.
  await q.addIndex(TableName.UserRoles, ['role_id'], { name: 'user_roles_role_idx' });
  await q.addConstraint(TableName.UserRoles, {
    type: 'check',
    name: 'user_roles_scope_chk',
    fields: ['scope'],
    where: Sequelize.literal(`"scope" IN (${inList(Object.values(Scope))})`),
  });

  // Row-Level Security
  const stmts = [
    ...customRls(TableName.Tenants, `id = current_setting('app.current_tenant', true)::uuid`),
    ...rlsPolicyStatements(TableName.Users),
    // Roles: READ admits the tenant's own custom roles AND the global (tenant_id NULL) system roles,
    // but WRITE is restricted to the current tenant — a tenant session must NOT be able to INSERT/
    // UPDATE a NULL-tenant system role that every other tenant would then see (BUG-0009). System-role
    // seeding runs outside a tenant context (no app.current_tenant), so it is unaffected.
    ...customRls(
      TableName.Roles,
      `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', true)::uuid`,
      `tenant_id = current_setting('app.current_tenant', true)::uuid`,
    ),
    ...rlsPolicyStatements(TableName.UserRoles),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.UserRoles);
  await q.dropTable(TableName.RolePermissions);
  await q.dropTable(TableName.Roles);
  await q.dropTable(TableName.Permissions);
  await q.dropTable(TableName.Users);
  await q.dropTable(TableName.Tenants);
}
