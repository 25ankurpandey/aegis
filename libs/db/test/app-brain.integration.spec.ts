/**
 * INTEGRATION test for the per-tenant app-brain (pgvector) semantic-memory store against the LIVE
 * Postgres. Mirrors entitlement.integration.spec.ts: the service runs as the NON-OWNER `aegis_app`
 * role so Row-Level Security is genuinely enforced (DATABASE_URL points at aegis_app BEFORE @aegis/db
 * is imported), and `withTenantTransaction` sets `app.current_tenant` per transaction. Tenants are
 * seeded as the OWNER (a superuser that bypasses RLS) over a separate connection; the memories
 * themselves are written THROUGH the service as aegis_app, exercising the RLS write path.
 *
 * Requires the live compose Postgres (migrated through 0033, pgvector installed). Skips (does not
 * fail) if unreachable.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

// Point the shared connection at the NON-OWNER role before importing @aegis/db.
process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { AppBrainService } from '../src/brain/app-brain.service';
import { getSequelize, closeSequelize } from '../src/connection';

const tenantA = randomUUID();
const tenantB = randomUUID();

let owner: Sequelize;
let live = true;

async function ping(): Promise<boolean> {
  try {
    owner = new Sequelize(OWNER_URL, { dialect: 'postgres', logging: false });
    await owner.authenticate();
    // Also confirm pgvector + the table exist (a DB migrated below 0033 should skip, not fail).
    const [{ ok }] = await owner.query<{ ok: boolean }>(
      `SELECT (to_regclass('public.app_brain_memory') IS NOT NULL) AS ok`,
      { type: QueryTypes.SELECT },
    );
    return ok === true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  live = await ping();
  if (!live) return;

  // Seed two tenants as OWNER (superuser bypasses RLS; app role cannot create tenants cross-tenant).
  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES
       ($1, 'Brain Tenant A', $3, 'active'),
       ($2, 'Brain Tenant B', $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenantA, tenantB, `a-${tenantA}`, `b-${tenantB}`], type: QueryTypes.INSERT },
  );

  // Write memories THROUGH the service as aegis_app (RLS write path). Tenant A gets three topically
  // distinct docs; tenant B gets its own 'revenue' doc (must stay invisible to A under RLS).
  const a = new AppBrainService({ tenantId: tenantA });
  await a.remember({
    kind: 'doc',
    ref: 'revenue',
    title: 'Revenue',
    content: 'quarterly revenue growth and invoices billed to customers',
  });
  await a.remember({
    kind: 'doc',
    ref: 'payroll',
    title: 'Payroll',
    content: 'employee payroll salaries benefits and tax withholding',
  });
  await a.remember({
    kind: 'doc',
    ref: 'ops',
    title: 'Ops',
    content: 'server latency deployment pipeline and uptime monitoring',
  });

  const b = new AppBrainService({ tenantId: tenantB });
  await b.remember({
    kind: 'doc',
    ref: 'revenue',
    title: 'Revenue (B)',
    content: 'tenant B revenue invoices customers and billing',
  });

  // eslint-disable-next-line no-console
  console.log('[app-brain integration] seeded memories for tenant A (3) + tenant B (1) (LIVE DB)');
});

afterAll(async () => {
  if (live && owner) {
    // Superuser owner cleans up both tenants' rows, then the tenants (CASCADE would also cover rows).
    await owner.query(`DELETE FROM app_brain_memory WHERE tenant_id IN ($1, $2)`, {
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

describe('AppBrainService (live Postgres + pgvector, RLS as aegis_app)', () => {
  it('connects as the non-owner app role (RLS enforced, not bypassed)', async () => {
    if (!live) return;
    const [{ role }] = await getSequelize().query<{ role: string }>(`SELECT current_user AS role`, {
      type: QueryTypes.SELECT,
    });
    expect(role).toBe('aegis_app');
  });

  it('recall ranks the topically-closest memory first (cosine nearest-neighbour)', async () => {
    if (!live) return;
    const a = new AppBrainService({ tenantId: tenantA });
    const hits = await a.recall('revenue invoices customers', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ref).toBe('revenue');
    // Distances are ordered ascending (nearest first).
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].distance).toBeGreaterThanOrEqual(hits[i - 1].distance);
    }
  });

  it('RLS isolates tenants: A never recalls B’s memory and vice versa', async () => {
    if (!live) return;
    const a = new AppBrainService({ tenantId: tenantA });
    const b = new AppBrainService({ tenantId: tenantB });

    // Both tenants have a 'revenue' doc, but each session only ever sees its own titles.
    const aHits = await a.recall('revenue invoices customers', 10);
    const bHits = await b.recall('revenue invoices customers', 10);

    expect(aHits.map((h) => h.title)).toContain('Revenue');
    expect(aHits.map((h) => h.title)).not.toContain('Revenue (B)');

    // B seeded only one memory; under RLS it sees exactly that one and never A's three.
    expect(bHits).toHaveLength(1);
    expect(bHits[0].title).toBe('Revenue (B)');
  });

  it('recall can filter by kind and upsert-by-ref replaces rather than duplicates', async () => {
    if (!live) return;
    const a = new AppBrainService({ tenantId: tenantA });

    // Re-remember the same (kind, ref) with new content — the partial-unique index makes it an upsert.
    await a.remember({
      kind: 'doc',
      ref: 'ops',
      title: 'Ops v2',
      content: 'server latency deployment pipeline uptime monitoring and alerting rules',
    });

    const opsHits = await a.recall('deployment pipeline monitoring', 10, { kind: 'doc' });
    const opsRows = opsHits.filter((h) => h.ref === 'ops');
    expect(opsRows).toHaveLength(1); // upsert, not a duplicate
    expect(opsRows[0].title).toBe('Ops v2');
  });
});
