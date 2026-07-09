/**
 * INTEGRATION test for the shared-DB PolicyReadPort (ABAC generalization Phase 1 —
 * docs/strategy/abac-generalization.md §3 Q6 option (a), §5 Phase 1) against the LIVE Postgres.
 *
 * It runs the port as the NON-OWNER `aegis_app` role so Row-Level Security is genuinely enforced:
 * DATABASE_URL is pointed at aegis_app BEFORE `@aegis/db` is imported (getSequelize reads it once),
 * and `withTenantTransaction` sets `app.current_tenant` per transaction. Seeding is done as the
 * OWNER over a separate connection — deliberately BYPASSING the PAP write-time hardening, which is
 * exactly how a malformed legacy row would exist in production (§3 Q2's one-time audit target), so
 * the fail-closed all-or-nothing load contract is proven against the real table (migration 0028).
 *
 * Requires the live compose Postgres (migrated through 0028+). Skips (does not fail) if unreachable.
 */
import { randomUUID } from 'crypto';
import { Sequelize, QueryTypes } from 'sequelize';

const OWNER_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';
const APP_URL = 'postgres://aegis_app:aegis_app_pw@127.0.0.1:55432/aegis';

// Point the shared connection at the NON-OWNER role before importing @aegis/db.
process.env.DATABASE_URL = APP_URL;
process.env.NODE_ENV = 'test';

import { Permission } from '@aegis/shared-enums';
import { dbPolicies } from '@aegis/access-control';
import { dbPolicyReadPort, registerDbPolicyReadPort } from '../src/policy-read-port';
import { getSequelize, closeSequelize } from '../src/connection';
import { withTenantTransaction } from '../src/transaction';

const APPROVE = Permission.ExpenseReportApprove; // 'expense.report.approve'

const tenantA = randomUUID();
const tenantB = randomUUID();
const denyPolicyId = randomUUID();
const inactivePolicyId = randomUUID();
const otherPermPolicyId = randomUUID();

/** The Phase-1 reference policy (§5 Phase 1): deny approve when resource.amount gt 1000. */
const DENY_RULE = { conditions: [{ attribute: 'resource.amount', operator: 'gt', value: 1000 }] };

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

/** Owner-side seed of one `policies` row (real migration-0028 shape; RLS bypassed as superuser). */
async function seedPolicy(row: {
  id: string;
  tenantId: string;
  permission: string;
  effect: string;
  rule: unknown;
  priority?: number;
  isActive?: boolean;
}): Promise<void> {
  await owner.query(
    `INSERT INTO policies (id, tenant_id, permission, effect, rule, priority, is_active)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    {
      bind: [
        row.id,
        row.tenantId,
        row.permission,
        row.effect,
        JSON.stringify(row.rule),
        row.priority ?? 100,
        row.isActive ?? true,
      ],
      type: QueryTypes.INSERT,
    },
  );
}

async function deletePolicy(id: string): Promise<void> {
  await owner.query(`DELETE FROM policies WHERE id = $1`, { bind: [id], type: QueryTypes.DELETE });
}

beforeAll(async () => {
  live = await ping();
  if (!live) return;

  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES
       ($1, 'Tenant A', $3, 'active'),
       ($2, 'Tenant B', $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    { bind: [tenantA, tenantB, `a-${tenantA}`, `b-${tenantB}`], type: QueryTypes.INSERT },
  );

  // Tenant A: the enforceable deny (priority 100, the migration default), an INACTIVE row on the
  // same permission (must be filtered), and an active row on a DIFFERENT permission (must not ride
  // along). Tenant B: no policies at all — and must see nothing of A's under RLS.
  await seedPolicy({ id: denyPolicyId, tenantId: tenantA, permission: APPROVE, effect: 'deny', rule: DENY_RULE });
  await seedPolicy({
    id: inactivePolicyId,
    tenantId: tenantA,
    permission: APPROVE,
    effect: 'deny',
    rule: { conditions: [] },
    isActive: false,
  });
  await seedPolicy({
    id: otherPermPolicyId,
    tenantId: tenantA,
    permission: Permission.ExpenseReportView,
    effect: 'deny',
    rule: { conditions: [] },
  });

  // eslint-disable-next-line no-console
  console.log(`[policy-read-port integration] seeded policies rows for tenant A (LIVE DB)`);
});

afterAll(async () => {
  if (live && owner) {
    await owner.query(`DELETE FROM policies WHERE tenant_id IN ($1, $2)`, {
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

describe('dbPolicyReadPort (live Postgres, RLS as aegis_app)', () => {
  it('connects as the non-owner app role (RLS enforced, not bypassed)', async () => {
    if (!live) return;
    const [{ role }] = await getSequelize().query<{ role: string }>(`SELECT current_user AS role`, {
      type: QueryTypes.SELECT,
    });
    expect(role).toBe('aegis_app');
  });

  it('loads exactly the tenant’s ACTIVE rows for the permission (inactive + other-permission rows excluded)', async () => {
    if (!live) return;
    const rows = await dbPolicyReadPort.listActive(tenantA, APPROVE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: denyPolicyId,
      tenant_id: tenantA,
      permission: APPROVE,
      effect: 'deny',
      rule: DENY_RULE, // JSONB comes back parsed
      priority: 100,
      is_active: true,
    });
  });

  it('end-to-end: the registered port + dbPolicies maps the persisted row into the PDP’s PolicyRule', async () => {
    if (!live) return;
    registerDbPolicyReadPort();
    const rules = await dbPolicies(APPROVE)({ userId: randomUUID(), tenantId: tenantA, roles: [] });
    expect(rules).toEqual([
      {
        id: denyPolicyId,
        tenantId: tenantA,
        effect: 'deny',
        action: APPROVE,
        conditions: DENY_RULE.conditions,
      },
    ]);
  });

  it('RLS isolation: a second tenant sees NOTHING — via the port AND via a predicate-free SELECT', async () => {
    if (!live) return;
    // Through the port (tenant predicate + RLS):
    await expect(dbPolicyReadPort.listActive(tenantB, APPROVE)).resolves.toEqual([]);

    // And with NO tenant_id predicate at all: under tenant B's RLS context, Postgres itself hides
    // tenant A's rows — proving the isolation is the RESTRICTIVE policy, not the WHERE clause.
    const visible = await withTenantTransaction(
      (t) =>
        getSequelize().query<{ id: string }>(`SELECT id FROM policies`, {
          type: QueryTypes.SELECT,
          transaction: t,
        }),
      { tenantId: tenantB },
    );
    expect(visible).toEqual([]);
  });

  it("the wildcard '*' bucket rides along with the permission's rows (PDP matches deny on action '*')", async () => {
    if (!live) return;
    const wildcardId = randomUUID();
    await seedPolicy({ id: wildcardId, tenantId: tenantA, permission: '*', effect: 'deny', rule: DENY_RULE, priority: 50 });
    try {
      const rows = await dbPolicyReadPort.listActive(tenantA, APPROVE);
      expect(rows.map((r) => r.id).sort()).toEqual([denyPolicyId, wildcardId].sort());
    } finally {
      await deletePolicy(wildcardId);
    }
  });

  it('a MALFORMED persisted row makes the WHOLE load THROW (all-or-nothing, fail closed) until remediated', async () => {
    if (!live) return;
    // Seeded as OWNER: bypasses the PAP write-time hardening exactly like a pre-hardening legacy row.
    // `scope` is banned from the v1 rule envelope (dead in the runtime — §3 Q1), so this row cannot map.
    const malformedId = randomUUID();
    await seedPolicy({
      id: malformedId,
      tenantId: tenantA,
      permission: APPROVE,
      effect: 'allow',
      rule: { scope: 'own_only' },
    });
    try {
      // The port refuses the whole (tenant, permission) load — including the perfectly valid deny row
      // fetched alongside. Never a partial set: dropping the bad row would fail open (§3 Q1/Q8).
      await expect(dbPolicyReadPort.listActive(tenantA, APPROVE)).rejects.toThrow(/POLICY_LOAD_FAILED/);

      // Same through the wired loader (what a route sees: the throw surfaces as a 5xx at the PEP).
      registerDbPolicyReadPort();
      await expect(
        dbPolicies(APPROVE)({ userId: randomUUID(), tenantId: tenantA, roles: [] }),
      ).rejects.toThrow(/POLICY_LOAD_FAILED/);
    } finally {
      await deletePolicy(malformedId);
    }

    // Remediation (deleting the bad row) restores the load — the valid deny is enforceable again.
    const rows = await dbPolicyReadPort.listActive(tenantA, APPROVE);
    expect(rows.map((r) => r.id)).toEqual([denyPolicyId]);
  });
});
