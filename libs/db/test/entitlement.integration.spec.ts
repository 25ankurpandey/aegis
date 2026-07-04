/**
 * INTEGRATION test for the per-tenant module entitlement core against the LIVE Postgres.
 *
 * It runs the service as the NON-OWNER `aegis_app` role so Row-Level Security is genuinely enforced:
 * DATABASE_URL is pointed at aegis_app BEFORE `@aegis/db` is imported (getSequelize reads it once),
 * and `withTenantTransaction` sets `app.current_tenant` per transaction. Seeding is done as the
 * OWNER over a separate connection (the app role cannot bypass RLS to seed cross-tenant).
 *
 * Requires the live compose Postgres (migrated through 0032). Skips (does not fail) if unreachable.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

// Point the shared connection at the NON-OWNER role before importing @aegis/db.
process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { EntitlementService } from '../src/entitlement/entitlement.service';
import { getSequelize, closeSequelize } from '../src/connection';
import { moduleIdFromTool, entitledModuleIds } from '../src/entitlement/tool-filter';

const tenantA = randomUUID();
const tenantB = randomUUID();
const pastExpiry = new Date(Date.now() - 60_000);
const futureExpiry = new Date(Date.now() + 3_600_000);

let owner: Sequelize;
let live = true;

async function ping(): Promise<boolean> {
  try {
    owner = new Sequelize(OWNER_URL, { dialect: 'postgres', logging: false });
    await owner.authenticate();
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  live = await ping();
  if (!live) return;

  // Seed two tenants + their entitlement rows as OWNER (RLS does not apply to the owner, and we
  // need to write across two tenants). tenant A: expense enabled/active; a suspended module; an
  // expired module. tenant B: expense enabled (must stay invisible to A under RLS).
  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES
       ($1, 'Tenant A', $3, 'active'),
       ($2, 'Tenant B', $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenantA, tenantB, `a-${tenantA}`, `b-${tenantB}`], type: QueryTypes.INSERT },
  );

  const rows: Array<[string, string, boolean, string, Date | null]> = [
    [tenantA, 'expense', true, 'active', null],
    [tenantA, 'payroll', true, 'suspended', null],
    [tenantA, 'reporting', true, 'active', pastExpiry],
    [tenantA, 'invoice', true, 'active', futureExpiry],
    [tenantA, 'disabled_mod', false, 'active', null],
    [tenantB, 'expense', true, 'active', null],
  ];
  for (const [tid, mod, enabled, status, exp] of rows) {
    await owner.query(
      `INSERT INTO tenant_modules (tenant_id, module_id, enabled, status, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, module_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, status = EXCLUDED.status, expires_at = EXCLUDED.expires_at`,
      { bind: [tid, mod, enabled, status, exp], type: QueryTypes.INSERT },
    );
  }

  const [{ count }] = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM tenant_modules WHERE tenant_id IN ($1, $2)`,
    { bind: [tenantA, tenantB], type: QueryTypes.SELECT },
  );
  // eslint-disable-next-line no-console
  console.log(`[entitlement integration] seeded tenant_modules rows for A+B: ${count} (LIVE DB)`);
});

afterAll(async () => {
  if (live && owner) {
    await owner.query(`DELETE FROM tenant_modules WHERE tenant_id IN ($1, $2)`, {
      bind: [tenantA, tenantB],
      type: QueryTypes.DELETE,
    });
    await owner.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, {
      bind: [tenantA, tenantB],
      type: QueryTypes.DELETE,
    });
    await owner.close();
  }
  await closeSequelize();
});

describe('EntitlementService (live Postgres, RLS as aegis_app)', () => {
  it('connects as the non-owner app role (RLS enforced, not bypassed)', async () => {
    if (!live) return;
    const [{ role }] = await getSequelize().query<{ role: string }>(
      `SELECT current_user AS role`,
      { type: QueryTypes.SELECT },
    );
    expect(role).toBe('aegis_app');
  });

  it('isModuleEnabled respects enabled AND status=active AND not expired', async () => {
    if (!live) return;
    const svc = new EntitlementService({ tenantId: tenantA });
    await expect(svc.isModuleEnabled('expense')).resolves.toBe(true); // enabled/active/no expiry
    await expect(svc.isModuleEnabled('invoice')).resolves.toBe(true); // future expiry
    await expect(svc.isModuleEnabled('payroll')).resolves.toBe(false); // suspended
    await expect(svc.isModuleEnabled('reporting')).resolves.toBe(false); // expired
    await expect(svc.isModuleEnabled('disabled_mod')).resolves.toBe(false); // enabled=false
    await expect(svc.isModuleEnabled('nonexistent')).resolves.toBe(false); // no row
  });

  it('listEnabledModuleIds returns only the tenant’s currently-entitled modules', async () => {
    if (!live) return;
    const svc = new EntitlementService({ tenantId: tenantA });
    const ids = await svc.listEnabledModuleIds();
    expect(ids.sort()).toEqual(['expense', 'invoice']);
  });

  it('RLS isolates tenants: A cannot see B’s rows, and vice versa', async () => {
    if (!live) return;
    const a = new EntitlementService({ tenantId: tenantA });
    const b = new EntitlementService({ tenantId: tenantB });

    // Both tenants have an 'expense' row, but each session only sees its own.
    await expect(a.isModuleEnabled('expense')).resolves.toBe(true);
    await expect(b.isModuleEnabled('expense')).resolves.toBe(true);

    // B has no invoice/payroll rows; A does. Under RLS, B sees none of A's modules.
    const bIds = await b.listEnabledModuleIds();
    expect(bIds).toEqual(['expense']);
    await expect(b.isModuleEnabled('invoice')).resolves.toBe(false);
  });

  it('setModuleEntitlement upserts under RLS and is visible only to that tenant', async () => {
    if (!live) return;
    const a = new EntitlementService({ tenantId: tenantA });
    const b = new EntitlementService({ tenantId: tenantB });

    await a.setModuleEntitlement({ moduleId: 'ephemeral', enabled: true, plan: 'pro' });
    await expect(a.isModuleEnabled('ephemeral')).resolves.toBe(true);
    // The write landed under tenant A only — B cannot see it.
    await expect(b.isModuleEnabled('ephemeral')).resolves.toBe(false);

    // Idempotent update flips it off.
    await a.setModuleEntitlement({ moduleId: 'ephemeral', enabled: false });
    await expect(a.isModuleEnabled('ephemeral')).resolves.toBe(false);

    // cleanup via owner in afterAll (DELETE covers all of tenant A's rows)
  });

  it('entitledModuleIds + moduleIdFromTool build a sync entitlement predicate', async () => {
    if (!live) return;
    const svc = new EntitlementService({ tenantId: tenantA });
    const set = await entitledModuleIds(svc);
    const isEnabled = (tool: { path: string }) => set.has(moduleIdFromTool(tool));

    expect(isEnabled({ path: '/expense/api/v1/expenses/:id' })).toBe(true);
    expect(isEnabled({ path: '/payroll/api/v1/runs' })).toBe(false); // suspended -> not entitled
    expect(moduleIdFromTool({ path: '/expense/api/v1/x' })).toBe('expense');
  });
});
