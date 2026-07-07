/**
 * INTEGRATION test for the Chargebee → entitlement loop against the LIVE Postgres: a parsed webhook
 * event is applied through {@link applyEntitlementChanges} (RLS-scoped upserts pinned to the event's
 * tenant) and the result is read back through {@link EntitlementService} as the NON-OWNER `aegis_app`
 * role. Mirrors entitlement.integration.spec.ts (owner seeds, app-role reads, live-skip guard).
 *
 * Requires the live compose Postgres (migrated through 0032). Skips (does not fail) if unreachable.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

// Point the shared connection at the NON-OWNER role before importing @aegis/db internals.
process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { parseChargebeeEvent, applyEntitlementChanges } from '../src/entitlement/chargebee-webhook';
import { EntitlementService } from '../src/entitlement/entitlement.service';
import { closeSequelize } from '../src/connection';

const tenantId = randomUUID();
const MODULE_MAP = { 'aegis-expense-pro': ['expense'], 'aegis-suite': ['expense', 'invoice'] };

/** The standard Chargebee envelope for this tenant (epoch SECONDS timestamps, like Chargebee). */
function event(eventType: string, subscription: Record<string, unknown> = {}): unknown {
  return {
    id: `ev_${eventType}`,
    occurred_at: 1780000000,
    event_type: eventType,
    content: {
      customer: { id: 'cust_1', cf_tenant_id: tenantId },
      subscription: { id: 'sub_1', plan_id: 'aegis-expense-pro', status: 'active', ...subscription },
    },
  };
}

let owner: Sequelize;
let live = true;

beforeAll(async () => {
  try {
    owner = new Sequelize(OWNER_URL, { dialect: 'postgres', logging: false });
    await owner.authenticate();
  } catch {
    live = false;
    return;
  }
  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1, 'Chargebee Tenant', $2, 'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenantId, `cb-${tenantId}`], type: QueryTypes.INSERT },
  );
});

afterAll(async () => {
  if (live && owner) {
    await owner.query(`DELETE FROM tenant_modules WHERE tenant_id = $1`, {
      bind: [tenantId],
      type: QueryTypes.DELETE,
    });
    await owner.query(`DELETE FROM tenants WHERE id = $1`, {
      bind: [tenantId],
      type: QueryTypes.DELETE,
    });
    await owner.close();
  }
  await closeSequelize();
});

describe('Chargebee webhook → tenant_modules (live Postgres, RLS as aegis_app)', () => {
  it('subscription_created materializes an enabled entitlement readable under RLS', async () => {
    if (!live) return;
    const changes = parseChargebeeEvent(event('subscription_created'), { moduleMap: MODULE_MAP });
    expect(changes).toHaveLength(1);
    const applied = await applyEntitlementChanges(changes);
    expect(applied).toBe(1);

    const svc = new EntitlementService({ tenantId });
    await expect(svc.isModuleEnabled('expense')).resolves.toBe(true);
  });

  it('replaying the SAME event is idempotent — still exactly one row', async () => {
    if (!live) return;
    const changes = parseChargebeeEvent(event('subscription_created'), { moduleMap: MODULE_MAP });
    await applyEntitlementChanges(changes);
    await applyEntitlementChanges(changes); // at-least-once delivery replay

    const [{ count }] = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tenant_modules WHERE tenant_id = $1 AND module_id = 'expense'`,
      { bind: [tenantId], type: QueryTypes.SELECT },
    );
    expect(count).toBe('1');
  });

  it('subscription_deleted disables the module (read back as aegis_app)', async () => {
    if (!live) return;
    const changes = parseChargebeeEvent(event('subscription_deleted'), { moduleMap: MODULE_MAP });
    expect(changes).toHaveLength(1);
    await applyEntitlementChanges(changes);

    const svc = new EntitlementService({ tenantId });
    await expect(svc.isModuleEnabled('expense')).resolves.toBe(false);
  });

  it('a suite plan grants multiple modules; cancellation keeps paid-through access until term end', async () => {
    if (!live) return;
    // Suite plan: two modules from one event.
    const created = parseChargebeeEvent(
      event('subscription_created', { plan_id: 'aegis-suite' }),
      { moduleMap: MODULE_MAP },
    );
    expect(created.map((c) => c.moduleId).sort()).toEqual(['expense', 'invoice']);
    await applyEntitlementChanges(created);

    const svc = new EntitlementService({ tenantId });
    await expect(svc.isModuleEnabled('invoice')).resolves.toBe(true);

    // Cancelled with a FUTURE term end → still enabled (paid-through grace, expiry checked on read).
    const futureTermEnd = Math.floor(Date.now() / 1000) + 3600;
    const cancelled = parseChargebeeEvent(
      event('subscription_cancelled', { plan_id: 'aegis-suite', current_term_end: futureTermEnd }),
      { moduleMap: MODULE_MAP },
    );
    await applyEntitlementChanges(cancelled);
    await expect(svc.isModuleEnabled('invoice')).resolves.toBe(true);

    // Cancelled with a PAST term end → expiry has lapsed, access off.
    const pastTermEnd = Math.floor(Date.now() / 1000) - 3600;
    const lapsed = parseChargebeeEvent(
      event('subscription_cancelled', { plan_id: 'aegis-suite', current_term_end: pastTermEnd }),
      { moduleMap: MODULE_MAP },
    );
    await applyEntitlementChanges(lapsed);
    await expect(svc.isModuleEnabled('invoice')).resolves.toBe(false);
  });
});
