/**
 * INTEGRATION test for the app-brain OWNER-SCOPING + PROVENANCE layer (migration 0036 — closes
 * AGENT-03 / MEM-01 / MEM-02 / MEM-03) against the LIVE Postgres. Mirrors app-brain-v2's harness:
 * the service runs as the NON-OWNER `aegis_app` role so tenant RLS is genuinely enforced
 * (DATABASE_URL points at aegis_app BEFORE @aegis/db is imported), and `withTenantTransaction` sets
 * `app.current_tenant` per transaction. The tenant is seeded as the OWNER (a superuser that bypasses
 * RLS); the owner connection is also used to ASSERT provenance columns the live read paths hide.
 *
 * The owner predicate is an APP-LAYER filter keyed on the SERVICE's `userId` (two same-tenant users
 * are two `AppBrainService` instances differing only in `userId`). Proves:
 *   1. user A remembers a PRIVATE fact; user B (same tenant) recall does NOT return it.
 *   2. a `team`-scoped fact IS visible to user B.
 *   3. user B's forgetBySubject cannot tombstone user A's private fact (MEM-02).
 *   4. created_by / updated_by are recorded (MEM-03).
 *   5. legacy owner-less rows (userId absent) stay visible to everyone (back-compat).
 *
 * Requires the live compose Postgres migrated through 0036. Skips (does not fail) if unreachable OR
 * if 0036 has not run — the ping checks information_schema for the `owner_user_id` column, so running
 * this spec before the migration is safe.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

// Point the shared connection at the NON-OWNER role before importing @aegis/db code.
process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { AppBrainService } from '../src/brain/app-brain.service';
import { closeSequelize } from '../src/connection';

const tenant = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

let owner: Sequelize;
let live = true;

async function ping(): Promise<boolean> {
  try {
    owner = new Sequelize(OWNER_URL, { dialect: 'postgres', logging: false });
    await owner.authenticate();
    // Owner-scoping needs the 0036 columns; a DB below 0036 (or without the table) skips, not fails.
    const [{ ok }] = await owner.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'app_brain_memory'
            AND column_name = 'owner_user_id'
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
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1, 'Brain Owner Tenant', $2, 'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenant, `owner-${tenant}`], type: QueryTypes.INSERT },
  );
});

afterAll(async () => {
  if (live && owner) {
    // Superuser owner cleans up ALL of the tenant's rows (including tombstoned ones), then the tenant.
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

describe('AppBrainService owner-scoping (live Postgres + pgvector, RLS as aegis_app)', () => {
  it("MEM-01: user A's PRIVATE fact is invisible to user B (same tenant)", async () => {
    if (!live) return;
    const svcA = new AppBrainService({ tenantId: tenant, userId: userA });
    const svcB = new AppBrainService({ tenantId: tenant, userId: userB });

    const stored = await svcA.remember({
      kind: 'note',
      subject: 'aegis-private-secret',
      content: 'the private launch code alpha is zircon seven',
    });
    expect(stored.ownerUserId).toBe(userA);
    expect(stored.scope).toBe('private');

    // A recalls their own private fact.
    const aHits = await svcA.recall('the private launch code alpha zircon', 10);
    expect(aHits.some((h) => h.id === stored.id)).toBe(true);

    // B (same tenant, different user) must NOT see A's private fact through any read path.
    const bHits = await svcB.recall('the private launch code alpha zircon', 10);
    expect(bHits.some((h) => h.id === stored.id)).toBe(false);
    const bSalient = await svcB.salient(50);
    expect(bSalient.some((h) => h.id === stored.id)).toBe(false);
  });

  it('scope="team": a team fact IS visible to another user in the tenant', async () => {
    if (!live) return;
    const svcA = new AppBrainService({ tenantId: tenant, userId: userA });
    const svcB = new AppBrainService({ tenantId: tenant, userId: userB });

    const shared = await svcA.remember({
      kind: 'note',
      scope: 'team',
      subject: 'aegis-team-fact',
      content: 'the office wifi password beryllium is shared with the whole team',
    });
    expect(shared.scope).toBe('team');
    expect(shared.ownerUserId).toBe(userA);

    const bHits = await svcB.recall('office wifi password beryllium shared team', 10);
    expect(bHits.some((h) => h.id === shared.id)).toBe(true);
  });

  it("MEM-02: user B's forgetBySubject cannot tombstone user A's private fact", async () => {
    if (!live) return;
    const svcA = new AppBrainService({ tenantId: tenant, userId: userA });
    const svcB = new AppBrainService({ tenantId: tenant, userId: userB });

    const aFact = await svcA.remember({
      kind: 'note',
      subject: 'aegis-mem02-subject',
      content: 'A owns this fact about the tungsten reactor schedule',
    });

    // B tries to forget by the SAME subject — must invalidate ZERO of A's rows.
    const forgotten = await svcB.forgetBySubject('aegis-mem02-subject');
    expect(forgotten).toBe(0);

    // A's fact is still LIVE (owner assert: valid_to still null).
    const [row] = await owner.query<{ valid_to: Date | null }>(
      `SELECT valid_to FROM app_brain_memory WHERE id = $1`,
      { bind: [aFact.id], type: QueryTypes.SELECT },
    );
    expect(row).toBeDefined();
    expect(row.valid_to).toBeNull();
    // And A can still recall it.
    const aHits = await svcA.recall('tungsten reactor schedule', 10);
    expect(aHits.some((h) => h.id === aFact.id)).toBe(true);

    // Sanity: A CAN forget their own fact.
    expect(await svcA.forgetBySubject('aegis-mem02-subject')).toBe(1);
  });

  it("MEM-02: user B's supersede-by-subject cannot tombstone user A's private fact", async () => {
    if (!live) return;
    const svcA = new AppBrainService({ tenantId: tenant, userId: userA });
    const svcB = new AppBrainService({ tenantId: tenant, userId: userB });

    const aFact = await svcA.remember({
      kind: 'note',
      subject: 'aegis-supersede-subject',
      content: 'A says the vault combination is molybdenum four',
    });
    // B remembers with the same subject: this must NOT tombstone A's row (it is B's own new row).
    await svcB.remember({
      kind: 'note',
      subject: 'aegis-supersede-subject',
      content: 'B says the vault combination is cadmium nine',
    });

    // A's original row is still LIVE — B's write could not supersede it.
    const [row] = await owner.query<{ valid_to: Date | null }>(
      `SELECT valid_to FROM app_brain_memory WHERE id = $1`,
      { bind: [aFact.id], type: QueryTypes.SELECT },
    );
    expect(row.valid_to).toBeNull();
    const aHits = await svcA.recall('vault combination molybdenum', 10);
    expect(aHits.some((h) => h.id === aFact.id)).toBe(true);
  });

  it('MEM-03: created_by / updated_by provenance is recorded', async () => {
    if (!live) return;
    const svcA = new AppBrainService({ tenantId: tenant, userId: userA });

    const stored = await svcA.remember({
      kind: 'note',
      content: 'provenance check for the palladium ledger entry',
    });
    expect(stored.createdBy).toBe(userA);
    expect(stored.updatedBy).toBe(userA);
    expect(stored.ownerUserId).toBe(userA);

    const [row] = await owner.query<{ created_by: string | null; updated_by: string | null }>(
      `SELECT created_by, updated_by FROM app_brain_memory WHERE id = $1`,
      { bind: [stored.id], type: QueryTypes.SELECT },
    );
    expect(row.created_by).toBe(userA);
    expect(row.updated_by).toBe(userA);
  });

  it('back-compat: legacy owner-less rows stay visible to every user', async () => {
    if (!live) return;
    // A row written with NO acting user is a legacy/owner-less row (owner_user_id IS NULL).
    const svcNoUser = new AppBrainService({ tenantId: tenant });
    const legacy = await svcNoUser.remember({
      kind: 'note',
      subject: 'aegis-legacy-subject',
      content: 'legacy shared knowledge about the rhodium pipeline',
    });
    expect(legacy.ownerUserId).toBeNull();

    // Both distinct users can recall the legacy row.
    const svcA = new AppBrainService({ tenantId: tenant, userId: userA });
    const svcB = new AppBrainService({ tenantId: tenant, userId: userB });
    const aHits = await svcA.recall('legacy rhodium pipeline knowledge', 10);
    const bHits = await svcB.recall('legacy rhodium pipeline knowledge', 10);
    expect(aHits.some((h) => h.id === legacy.id)).toBe(true);
    expect(bHits.some((h) => h.id === legacy.id)).toBe(true);
  });
});
