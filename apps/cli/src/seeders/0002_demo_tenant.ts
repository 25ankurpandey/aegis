import { type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { randomUUID as uuid, randomBytes, scryptSync } from 'node:crypto';
import { Scope, SystemRole, TableName } from '@aegis/shared-enums';

/** A fixed demo tenant so login + PAP flows are immediately exercisable after dev-up. */
const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_EMAIL = 'admin@demo-org.test';
const DEMO_PASSWORD = 'demo-admin-pw';

function hash(plain: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(plain, salt, 64).toString('hex')}`;
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const now = new Date();
  // Bootstrap: set the tenant context so RLS WITH CHECK accepts the tenant-scoped inserts.
  await q.sequelize.query(`SELECT set_config('app.current_tenant', '${DEMO_TENANT_ID}', false)`);

  await q.bulkInsert(TableName.Tenants, [
    { id: DEMO_TENANT_ID, name: 'Demo Org', slug: 'demo-org', status: 'active', created_at: now, updated_at: now },
  ]);

  const userId = uuid();
  await q.bulkInsert(TableName.Users, [
    {
      id: userId,
      tenant_id: DEMO_TENANT_ID,
      email: DEMO_EMAIL,
      first_name: 'Demo',
      last_name: 'Admin',
      password_hash: hash(DEMO_PASSWORD),
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  ]);

  const [roles] = await q.sequelize.query(
    `SELECT id FROM "${TableName.Roles}" WHERE name = '${SystemRole.Admin}' AND is_system = true LIMIT 1`,
  );
  const adminRoleId = (roles as Array<{ id: string }>)[0]?.id;
  if (adminRoleId) {
    await q.bulkInsert(TableName.UserRoles, [
      { id: uuid(), tenant_id: DEMO_TENANT_ID, user_id: userId, role_id: adminRoleId, scope: Scope.AllRecords, created_at: now, updated_at: now },
    ]);
  }
  console.log(`[seed] demo tenant ${DEMO_TENANT_ID}; login: ${DEMO_EMAIL} / ${DEMO_PASSWORD} (X-Tenant-Id: ${DEMO_TENANT_ID})`);
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`SELECT set_config('app.current_tenant', '${DEMO_TENANT_ID}', false)`);
  await q.bulkDelete(TableName.UserRoles, { tenant_id: DEMO_TENANT_ID });
  await q.bulkDelete(TableName.Users, { tenant_id: DEMO_TENANT_ID });
  await q.bulkDelete(TableName.Tenants, { id: DEMO_TENANT_ID });
}
