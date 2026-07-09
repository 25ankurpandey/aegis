/**
 * INTEGRATION test for the PIP (Policy Information Point) data-access semantics against the LIVE
 * Postgres. The login path (user-management `UserRepository.loadPipAttributes`) resolves a user's
 * `teamIds` (from `team_members`) and `managerOf` (from `approval_hierarchy`) and mints them into the
 * signed token. This test runs the EXACT two queries that method runs, as the NON-OWNER `aegis_app`
 * role under RLS, and proves (a) they resolve the seeded rows and (b) they are TENANT-ISOLATED — so
 * the PIP can never leak another tenant's team/hierarchy data into a token.
 *
 * Requires the live compose Postgres. Skips (does not fail) if unreachable.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { getSequelize, closeSequelize } from '../src/connection';
import { withTenantTransaction } from '../src/transaction';

const tenantA = randomUUID();
const tenantB = randomUUID();
const managerA = randomUUID();
const reportA = randomUUID(); // a user that reports to managerA (tenant A)
const teamA = randomUUID();
const userB = randomUUID();
const teamB = randomUUID();

let owner: Sequelize;
let live = true;

/** The exact queries UserRepository.loadPipAttributes runs, executed under RLS as aegis_app. */
async function loadPip(tenantId: string, userId: string): Promise<{ teamIds: string[]; managerOf: string[] }> {
  return withTenantTransaction(async (t) => {
    const sequelize = getSequelize();
    const teamRows = await sequelize.query<{ team_id: string }>(
      `SELECT DISTINCT team_id FROM team_members WHERE user_id = $1`,
      { bind: [userId], type: QueryTypes.SELECT, transaction: t },
    );
    const managedRows = await sequelize.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM approval_hierarchy WHERE manager_id = $1`,
      { bind: [userId], type: QueryTypes.SELECT, transaction: t },
    );
    return { teamIds: teamRows.map((r) => r.team_id), managerOf: managedRows.map((r) => r.user_id) };
  }, { tenantId });
}

beforeAll(async () => {
  try {
    owner = new Sequelize(OWNER_URL, { dialect: 'postgres', logging: false });
    await owner.authenticate();
  } catch {
    live = false;
    return;
  }
  // Seed as OWNER (superuser bypasses RLS). Two tenants; tenant A gets a manager, a report, a team,
  // a team membership, and a hierarchy row. Tenant B gets its own team + membership (must stay
  // invisible to A under RLS).
  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1,'PIP A',$3,'active'),($2,'PIP B',$4,'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenantA, tenantB, `pipa-${tenantA}`, `pipb-${tenantB}`], type: QueryTypes.INSERT },
  );
  await owner.query(
    `INSERT INTO users (id, tenant_id, email, password_hash, status) VALUES
       ($1,$2,$3,'x','active'),($4,$2,$5,'x','active'),($6,$7,$8,'x','active')
     ON CONFLICT (id) DO NOTHING`,
    {
      bind: [managerA, tenantA, `mgr-${managerA}@t.io`, reportA, `rep-${reportA}@t.io`, userB, tenantB, `b-${userB}@t.io`],
      type: QueryTypes.INSERT,
    },
  );
  await owner.query(
    `INSERT INTO teams (id, tenant_id, name, is_active) VALUES ($1,$2,'Team A',true),($3,$4,'Team B',true)
     ON CONFLICT (id) DO NOTHING`,
    { bind: [teamA, tenantA, teamB, tenantB], type: QueryTypes.INSERT },
  );
  await owner.query(
    `INSERT INTO team_members (id, tenant_id, team_id, user_id, role) VALUES
       ($1,$2,$3,$4,'member'),($5,$6,$7,$8,'member')`,
    { bind: [randomUUID(), tenantA, teamA, managerA, randomUUID(), tenantB, teamB, userB], type: QueryTypes.INSERT },
  );
  await owner.query(
    `INSERT INTO approval_hierarchy (id, tenant_id, user_id, manager_id, depth) VALUES ($1,$2,$3,$4,1)`,
    { bind: [randomUUID(), tenantA, reportA, managerA], type: QueryTypes.INSERT },
  );
});

afterAll(async () => {
  if (live && owner) {
    await owner.query(`DELETE FROM approval_hierarchy WHERE tenant_id IN ($1,$2)`, { bind: [tenantA, tenantB], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM team_members WHERE tenant_id IN ($1,$2)`, { bind: [tenantA, tenantB], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM teams WHERE tenant_id IN ($1,$2)`, { bind: [tenantA, tenantB], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM users WHERE tenant_id IN ($1,$2)`, { bind: [tenantA, tenantB], type: QueryTypes.DELETE });
    await owner.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, { bind: [tenantA, tenantB], type: QueryTypes.DELETE });
    await owner.close();
  }
  await closeSequelize();
});

describe('PIP attributes (live Postgres, RLS as aegis_app)', () => {
  it('resolves teamIds and managerOf for the user', async () => {
    if (!live) return;
    const pip = await loadPip(tenantA, managerA);
    expect(pip.teamIds).toEqual([teamA]);
    expect(pip.managerOf).toEqual([reportA]); // managerA manages reportA
  });

  it('a user with no team / no reports resolves to empty arrays', async () => {
    if (!live) return;
    const pip = await loadPip(tenantA, reportA);
    expect(pip.teamIds).toEqual([]);
    expect(pip.managerOf).toEqual([]);
  });

  it('is TENANT-ISOLATED: tenant B never sees tenant A team memberships (RLS)', async () => {
    if (!live) return;
    // Query managerA's memberships while pinned to tenant B → RLS hides tenant A's rows entirely.
    const leaked = await loadPip(tenantB, managerA);
    expect(leaked.teamIds).toEqual([]);
    expect(leaked.managerOf).toEqual([]);
    // Tenant B's own user resolves its own team.
    const pipB = await loadPip(tenantB, userB);
    expect(pipB.teamIds).toEqual([teamB]);
  });
});
