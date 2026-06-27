import { randomUUID as uuid } from 'node:crypto';
import { QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { SystemRole, TableName } from '@aegis/shared-enums';
import { ALL_PERMISSIONS, ROLE_PERMS } from './rbac-catalog';

const CASBIN_TABLE = 'casbin';

interface RoleRow {
  id: string;
  name: SystemRole;
  tenant_id: string | null;
}

interface PermissionRow {
  id: string;
  name: string;
}

interface PRow {
  role_name: string;
  role_tenant_id: string | null;
  permission_name: string;
}

interface GRow {
  user_id: string;
  role_name: string;
  tenant_id: string;
}

async function insertCasbinRule(q: QueryInterface, ptype: string, rule: string[]): Promise<void> {
  await q.sequelize.query(
    `INSERT INTO "${CASBIN_TABLE}" (ptype, rule)
       SELECT $1, $2::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM "${CASBIN_TABLE}" WHERE rule = $2::jsonb
       )`,
    { bind: [ptype, JSON.stringify(rule)], type: QueryTypes.INSERT },
  );
}

/**
 * Reconcile seed data that is intentionally tracked by Umzug metadata.
 *
 * Older local DBs may already have `0001_system_roles` and `0003_casbin_policies` marked complete,
 * so those seeders must not rerun. When the Permission enum grows, this additive seeder tops up the
 * relational catalog and projects the missing p/g rules into Casbin without deleting existing state.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const now = new Date();

  const existingPermissions = await q.sequelize.query<PermissionRow>(
    `SELECT id, name FROM "${TableName.Permissions}"`,
    { type: QueryTypes.SELECT },
  );
  const permissionIds = new Map(existingPermissions.map((row) => [row.name, row.id]));
  const missingPermissions = ALL_PERMISSIONS.filter((name) => !permissionIds.has(name)).map((name) => {
    const id = uuid();
    permissionIds.set(name, id);
    return { id, name, description: name, created_at: now, updated_at: now };
  });
  if (missingPermissions.length > 0) {
    await q.bulkInsert(TableName.Permissions, missingPermissions);
  }

  const roles = await q.sequelize.query<RoleRow>(
    `SELECT id, name, tenant_id FROM "${TableName.Roles}" WHERE is_system = true`,
    { type: QueryTypes.SELECT },
  );
  const roleIds = new Map(roles.map((row) => [row.name, row.id]));

  const existingPairs = await q.sequelize.query<{ role_id: string; permission_id: string }>(
    `SELECT role_id, permission_id FROM "${TableName.RolePermissions}"`,
    { type: QueryTypes.SELECT },
  );
  const seenPairs = new Set(existingPairs.map((row) => `${row.role_id}:${row.permission_id}`));
  const missingPairs: Record<string, unknown>[] = [];
  for (const role of Object.values(SystemRole)) {
    const roleId = roleIds.get(role);
    if (!roleId) continue;
    for (const permission of ROLE_PERMS[role]) {
      const permissionId = permissionIds.get(permission);
      if (!permissionId) continue;
      const key = `${roleId}:${permissionId}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      missingPairs.push({ id: uuid(), role_id: roleId, permission_id: permissionId, created_at: now, updated_at: now });
    }
  }
  if (missingPairs.length > 0) {
    await q.bulkInsert(TableName.RolePermissions, missingPairs);
  }

  const pRows = await q.sequelize.query<PRow>(
    `SELECT r.name AS role_name, r.tenant_id AS role_tenant_id, p.name AS permission_name
       FROM "${TableName.RolePermissions}" rp
       JOIN "${TableName.Roles}" r ON r.id = rp.role_id
       JOIN "${TableName.Permissions}" p ON p.id = rp.permission_id`,
    { type: QueryTypes.SELECT },
  );
  for (const row of pRows) {
    await insertCasbinRule(q, 'p', [row.role_name, row.role_tenant_id ?? '*', row.permission_name, 'allow']);
  }

  const gRows = await q.sequelize.query<GRow>(
    `SELECT ur.user_id AS user_id, r.name AS role_name, ur.tenant_id AS tenant_id
       FROM "${TableName.UserRoles}" ur
       JOIN "${TableName.Roles}" r ON r.id = ur.role_id`,
    { type: QueryTypes.SELECT },
  );
  for (const row of gRows) {
    await insertCasbinRule(q, 'g', [row.user_id, row.role_name, row.tenant_id]);
  }

  console.log(
    `[seed] rbac reconcile: ${missingPermissions.length} permissions, ${missingPairs.length} role grants, casbin topped up`,
  );
}

export async function down(): Promise<void> {
  // Additive reconcile only. Do not remove permissions/grants on down; earlier seeders own base data.
}
