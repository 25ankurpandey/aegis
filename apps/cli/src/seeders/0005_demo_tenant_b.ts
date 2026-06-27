import { type QueryInterface, QueryTypes } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { randomUUID as uuid, randomBytes, scryptSync } from 'node:crypto';
import { Scope, SystemRole, TableName } from '@aegis/shared-enums';

/**
 * A SECOND fixed demo tenant ("Demo Org B") so cross-tenant RLS isolation is push-button in the live
 * E2E (two real admins, two real tenants — prove tenant A's token can never see tenant B's rows, and
 * vice-versa). The first demo tenant (`0002_demo_tenant`) is intentionally left untouched.
 *
 * Self-contained: this seeder creates the tenant + its admin user + the admin `user_role` AND projects
 * that membership into the `casbin` policy store itself (mirroring `0003_casbin_policies`), so it is
 * correct regardless of where it sits in the seeder order — the casbin reseed in 0003 already covers
 * any membership that exists when it runs, and this top-up is idempotent (skips rules already present).
 *
 * Only the demo tenants are seeded; everything else is created at runtime via the public API. This row
 * exists purely to give the RLS-isolation flow a real second tenant to assert against.
 */
const TENANT_B_ID = '00000000-0000-4000-8000-000000000002';
const TENANT_B_EMAIL = 'admin@demo-org-b.test';
const TENANT_B_PASSWORD = 'demo-admin-pw-b';
const CASBIN_TABLE = 'casbin';

function hash(plain: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(plain, salt, 64).toString('hex')}`;
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const now = new Date();
  const seq = q.sequelize;

  // Bootstrap: set the tenant context so RLS WITH CHECK accepts the tenant-scoped inserts.
  await seq.query(`SELECT set_config('app.current_tenant', '${TENANT_B_ID}', false)`);

  await q.bulkInsert(TableName.Tenants, [
    { id: TENANT_B_ID, name: 'Demo Org B', slug: 'demo-org-b', status: 'active', created_at: now, updated_at: now },
  ]);

  const userId = uuid();
  await q.bulkInsert(TableName.Users, [
    {
      id: userId,
      tenant_id: TENANT_B_ID,
      email: TENANT_B_EMAIL,
      first_name: 'Demo',
      last_name: 'Admin B',
      password_hash: hash(TENANT_B_PASSWORD),
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  ]);

  // The Admin system role is shared (tenant_id IS NULL); look it up the same way 0002 does.
  const [roles] = await seq.query(
    `SELECT id FROM "${TableName.Roles}" WHERE name = '${SystemRole.Admin}' AND is_system = true LIMIT 1`,
  );
  const adminRoleId = (roles as Array<{ id: string }>)[0]?.id;
  if (!adminRoleId) {
    console.log('[seed] tenant B: admin system role missing — run 0001_system_roles first');
    return;
  }

  await q.bulkInsert(TableName.UserRoles, [
    { id: uuid(), tenant_id: TENANT_B_ID, user_id: userId, role_id: adminRoleId, scope: Scope.AllRecords, created_at: now, updated_at: now },
  ]);

  // Top up the casbin g-rule for this membership so tenant B's admin is authorized at enforcer load,
  // independent of whether 0003_casbin_policies ran before or after this seeder. The p-rules for the
  // shared Admin role (dom '*') are already seeded by 0003 from the same role/permission catalog.
  const gRule = JSON.stringify([userId, SystemRole.Admin, TENANT_B_ID]);
  const existing = await seq.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM "${CASBIN_TABLE}" WHERE ptype = 'g' AND rule = $1::jsonb`,
    { bind: [gRule], type: QueryTypes.SELECT },
  );
  if (Number(existing[0]?.count ?? 0) === 0) {
    await seq.query(`INSERT INTO "${CASBIN_TABLE}" (ptype, rule) VALUES ('g', $1::jsonb)`, {
      bind: [gRule],
      type: QueryTypes.INSERT,
    });
  }

  console.log(
    `[seed] demo tenant B ${TENANT_B_ID}; login: ${TENANT_B_EMAIL} / ${TENANT_B_PASSWORD} (X-Tenant-Id: ${TENANT_B_ID})`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const seq = q.sequelize;
  await seq.query(`SELECT set_config('app.current_tenant', '${TENANT_B_ID}', false)`);

  // Drop the casbin g-rules for any user in tenant B (rule = [user, role, TENANT_B_ID]).
  await seq.query(`DELETE FROM "${CASBIN_TABLE}" WHERE ptype = 'g' AND rule->>2 = '${TENANT_B_ID}'`);
  await q.bulkDelete(TableName.UserRoles, { tenant_id: TENANT_B_ID });
  await q.bulkDelete(TableName.Users, { tenant_id: TENANT_B_ID });
  await q.bulkDelete(TableName.Tenants, { id: TENANT_B_ID });
}
