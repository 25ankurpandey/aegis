/**
 * INTEGRATION test for the v2 app-brain (Wayfinder memory semantics — supersede-by-subject,
 * soft-invalidation, embedder-space tagging, minScore, profile/salient) against the LIVE Postgres.
 * Mirrors app-brain.integration.spec.ts: the service runs as the NON-OWNER `aegis_app` role so
 * Row-Level Security is genuinely enforced (DATABASE_URL points at aegis_app BEFORE @aegis/db is
 * imported), and `withTenantTransaction` sets `app.current_tenant` per transaction. The tenant is
 * seeded as the OWNER (a superuser that bypasses RLS) over a separate connection; the owner
 * connection is also used to ASSERT tombstones (`valid_to`) that the live read paths must hide.
 *
 * Requires the live compose Postgres migrated through 0034 (the v2 columns). Skips (does not fail)
 * if unreachable OR if the DB has not run 0034 yet — the ping checks information_schema for the
 * `subject` column, so running this spec before the migration is safe.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

// Point the shared connection at the NON-OWNER role before importing @aegis/db code.
process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { AppBrainService } from '../src/brain/app-brain.service';
import { indexTools } from '../src/brain/indexers';
import { closeSequelize } from '../src/connection';

const tenant = randomUUID();

let owner: Sequelize;
let live = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ping(): Promise<boolean> {
  try {
    owner = new Sequelize(OWNER_URL, { dialect: 'postgres', logging: false });
    await owner.authenticate();
    // v2 needs the 0034 columns; a DB migrated below 0034 (or without the table) skips, not fails.
    const [{ ok }] = await owner.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'app_brain_memory'
            AND column_name = 'subject'
       ) AS ok`,
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

  // Seed the tenant as OWNER (superuser bypasses RLS; the app role cannot create tenants).
  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1, 'Brain V2 Tenant', $2, 'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenant, `v2-${tenant}`], type: QueryTypes.INSERT },
  );
});

afterAll(async () => {
  if (live && owner) {
    // Superuser owner cleans up the tenant's rows (INCLUDING soft-invalidated ones), then the tenant.
    await owner.query(`DELETE FROM app_brain_memory WHERE tenant_id = $1`, {
      bind: [tenant],
      type: QueryTypes.DELETE,
    });
    await owner.query(`DELETE FROM tenants WHERE id = $1`, {
      bind: [tenant],
      type: QueryTypes.DELETE,
    });
  }
  if (owner) {
    try {
      await owner.close();
    } catch {
      /* ping may have failed mid-connect; nothing to close */
    }
  }
  await closeSequelize();
});

describe('AppBrainService v2 (live Postgres + pgvector, RLS as aegis_app)', () => {
  it('supersede-by-subject: a fresh fact replaces the stale one (old row tombstoned, not deleted)', async () => {
    if (!live) return;
    const svc = new AppBrainService({ tenantId: tenant });

    const first = await svc.remember({
      kind: 'note',
      subject: 'car-location',
      content: 'my car is parked on level 3 of the office garage',
    });
    await sleep(5);
    // Different case + padding on the subject proves supersession matches trimmed lower(subject).
    const second = await svc.remember({
      kind: 'note',
      subject: '  Car-Location ',
      content: 'my car is parked on level 5 of the office garage',
    });

    const hits = await svc.recall('where is my car parked in the garage', 10);
    const carHits = hits.filter((h) => h.subject?.toLowerCase() === 'car-location');
    expect(carHits).toHaveLength(1); // ONLY the fresh fact is live
    expect(carHits[0].id).toBe(second.id);
    expect(carHits[0].content).toContain('level 5');
    expect(carHits[0].validTo).toBeNull();
    expect(carHits[0].embedder).toBe('fnv1a-bow-384/v1');

    // The superseded row still EXISTS (audit/history) but carries a valid_to tombstone.
    const [old] = await owner.query<{ valid_to: Date | null }>(
      `SELECT valid_to FROM app_brain_memory WHERE id = $1`,
      { bind: [first.id], type: QueryTypes.SELECT },
    );
    expect(old).toBeDefined();
    expect(old.valid_to).not.toBeNull();
  });

  it('forgetBySubject soft-invalidates: recall stops returning it, the row survives with valid_to', async () => {
    if (!live) return;
    const svc = new AppBrainService({ tenantId: tenant });

    await svc.remember({
      kind: 'note',
      subject: 'lunch-order',
      content: 'ordered a chicken burrito bowl for lunch from the cafe',
    });
    const forgotten = await svc.forgetBySubject('lunch-order');
    expect(forgotten).toBe(1);

    const hits = await svc.recall('what did I order for lunch from the cafe', 10);
    expect(hits.filter((h) => h.subject?.toLowerCase() === 'lunch-order')).toHaveLength(0);

    const rows = await owner.query<{ valid_to: Date | null }>(
      `SELECT valid_to FROM app_brain_memory WHERE tenant_id = $1 AND lower(subject) = 'lunch-order'`,
      { bind: [tenant], type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1); // still stored — soft-invalidated, not deleted
    expect(rows[0].valid_to).not.toBeNull();

    // A blank subject forgets nothing.
    expect(await svc.forgetBySubject('   ')).toBe(0);
  });

  it('minScore drops weak hits: an unrelated query returns rows at 0 but none at 0.95', async () => {
    if (!live) return;
    const svc = new AppBrainService({ tenantId: tenant });

    // Live rows exist from the earlier tests; this query shares no tokens with any of them.
    const all = await svc.recall('zebra xylophone quantum entanglement', 10, { minScore: 0 });
    const strong = await svc.recall('zebra xylophone quantum entanglement', 10, { minScore: 0.95 });

    expect(all.length).toBeGreaterThan(0); // minScore 0 admits everything (distance <= 1)
    expect(strong.length).toBeLessThan(all.length);
    expect(strong).toHaveLength(0); // nothing is ≥ 0.95 similar to an unrelated query
  });

  it('profile() returns only kind="profile" rows and salient() returns newest-first across kinds', async () => {
    if (!live) return;
    const svc = new AppBrainService({ tenantId: tenant });

    await svc.remember({
      kind: 'profile',
      subject: 'user-name',
      content: 'the user is called Ankur and prefers direct answers',
    });
    await sleep(5);
    const newest = await svc.remember({
      kind: 'profile',
      subject: 'user-language',
      content: 'the user speaks English and Hindi',
    });

    const prof = await svc.profile();
    expect(prof.length).toBe(2); // only the two profile rows, never the notes
    expect(prof.every((m) => m.kind === 'profile')).toBe(true);
    expect(prof[0].id).toBe(newest.id); // newest updated first
    for (let i = 1; i < prof.length; i++) {
      expect(prof[i].updatedAt.getTime()).toBeLessThanOrEqual(prof[i - 1].updatedAt.getTime());
    }

    const sal = await svc.salient(50);
    expect(sal.length).toBeGreaterThan(2); // spans kinds (notes + profile), live rows only
    expect(new Set(sal.map((m) => m.kind)).size).toBeGreaterThan(1);
    expect(sal[0].id).toBe(newest.id); // the most recent write leads
    for (let i = 1; i < sal.length; i++) {
      expect(sal[i].updatedAt.getTime()).toBeLessThanOrEqual(sal[i - 1].updatedAt.getTime());
    }
    expect(sal.every((m) => m.validTo === null)).toBe(true);
  });

  it('indexTools brings tools online: recall("create an expense") ranks the expense tool first', async () => {
    if (!live) return;
    const svc = new AppBrainService({ tenantId: tenant });

    const tools = [
      {
        name: 'expense.create',
        description: 'Create a new expense for reimbursement',
        method: 'POST',
        path: '/api/expenses',
        requiredPermissions: ['expense:write'] as const,
      },
      {
        name: 'invoice.send',
        description: 'Send an invoice to a customer by email',
        method: 'POST',
        path: '/api/invoices/send',
        requiredPermissions: ['invoice:write'] as const,
      },
      {
        name: 'payroll.run',
        description: 'Run the monthly payroll for all employees',
        method: 'POST',
        path: '/api/payroll/run',
        requiredPermissions: ['payroll:admin'] as const,
      },
    ];
    expect(await indexTools(svc, tools)).toBe(3);

    const hits = await svc.recall('create an expense', 5, { kind: 'tool' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ref).toBe('expense.create');
    expect(hits[0].kind).toBe('tool');

    // Re-indexing is idempotent: supersede-by-subject + upsert-by-ref keep ONE live row per tool.
    expect(await indexTools(svc, tools)).toBe(3);
    const again = await svc.recall('create an expense', 10, { kind: 'tool' });
    expect(again.filter((h) => h.ref === 'expense.create')).toHaveLength(1);
    expect(again.filter((h) => h.ref === 'expense.create')[0].validTo).toBeNull();
  });
});
