import { Permission } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';
import { amountCapPolicies, combinePolicies, dbPolicies } from '../src/policy-loader';
import { registerAccessControlPorts, resetAccessControlPorts, type PolicyReadPort } from '../src/policy-ports';
import type { PolicyRow } from '../src/policy-row-mapper';

/**
 * OFFLINE Phase-1 tests for the DB-backed `dbPolicies` loader (ABAC generalization —
 * docs/strategy/abac-generalization.md §3 Q6, §5 Phase 1) against a STUBBED `PolicyReadPort`:
 * rules flow + field mapping, `priority ASC, id ASC` determinism, the fail-closed ladder
 * (unregistered port ⇒ throw per the Q6 boot-order guard; port errors propagate; any unmappable
 * row fails the WHOLE load), and `combinePolicies` composition with the legacy amount-cap leg.
 * The LIVE RLS-scoped read is covered by libs/db/test/policy-read-port.integration.spec.ts.
 */

const ACTION = Permission.ExpenseReportApprove;
const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

const principal: AccessShape.Principal = {
  userId: 'bbbbbbbb-0000-0000-0000-000000000001',
  tenantId: TENANT,
  roles: ['approver'],
};

/** A valid persisted deny row (the Phase-1 reference policy: deny approve when amount gt X). */
function denyRow(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenant_id: TENANT,
    permission: ACTION,
    effect: 'deny',
    rule: { conditions: [{ attribute: 'resource.amount', operator: 'gt', value: 1000 }] },
    priority: 100,
    is_active: true,
    ...overrides,
  };
}

function stubPort(rows: PolicyRow[]): PolicyReadPort & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    listActive: async (tenantId: string, permission: string) => {
      calls.push([tenantId, permission]);
      return rows;
    },
  };
}

describe('dbPolicies (DB-backed loader, stubbed port)', () => {
  beforeEach(() => resetAccessControlPorts());
  afterAll(() => resetAccessControlPorts());

  it('UNREGISTERED port ⇒ THROWS (Q6 boot-order guard) — never a silent [] that un-gates allow-gated actions', async () => {
    await expect(dbPolicies(ACTION)(principal)).rejects.toThrow(/POLICY_LOAD_FAILED/);
    await expect(dbPolicies(ACTION)(principal)).rejects.toThrow(/registerDbPolicyReadPort/);
  });

  it('maps persisted rows into PolicyRule[] and queries the port with (principal.tenantId, action)', async () => {
    const port = stubPort([denyRow()]);
    registerAccessControlPorts({ policyRead: port });

    const rules = await dbPolicies(ACTION)(principal);

    expect(port.calls).toEqual([[TENANT, ACTION]]);
    expect(rules).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        tenantId: TENANT,
        effect: 'deny',
        action: ACTION,
        conditions: [{ attribute: 'resource.amount', operator: 'gt', value: 1000 }],
      },
    ]);
  });

  it('preserves priority order: rules come back priority ASC, id ASC regardless of fetch order', async () => {
    const rows: PolicyRow[] = [
      denyRow({ id: '33333333-3333-3333-3333-333333333333', priority: 200 }),
      // Same priority as the row below — the id breaks the tie deterministically.
      denyRow({ id: '22222222-2222-2222-2222-222222222222', priority: 100 }),
      denyRow({ id: '11111111-1111-1111-1111-111111111111', priority: 100 }),
    ];
    registerAccessControlPorts({ policyRead: stubPort(rows) });

    const rules = await dbPolicies(ACTION)(principal);
    expect(rules.map((r) => r.id)).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ]);
  });

  it("a wildcard-permission DENY row rides along mapped to action '*' (the PDP matches it on any action)", async () => {
    registerAccessControlPorts({
      policyRead: stubPort([denyRow({ id: '44444444-4444-4444-4444-444444444444', permission: '*' })]),
    });
    const rules = await dbPolicies(ACTION)(principal);
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe('*');
    expect(rules[0].effect).toBe('deny');
  });

  it('is_active=false rows are filtered (the one legitimate drop — an administered state)', async () => {
    registerAccessControlPorts({
      policyRead: stubPort([
        denyRow(),
        denyRow({ id: '55555555-5555-5555-5555-555555555555', is_active: false }),
      ]),
    });
    const rules = await dbPolicies(ACTION)(principal);
    expect(rules.map((r) => r.id)).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('a REGISTERED port error PROPAGATES untouched (fail closed ⇒ 5xx at the PEP, never [])', async () => {
    const boom = new Error('connection refused');
    registerAccessControlPorts({
      policyRead: {
        listActive: async () => {
          throw boom;
        },
      },
    });
    await expect(dbPolicies(ACTION)(principal)).rejects.toBe(boom);
  });

  it('ANY unmappable row fails the WHOLE load (all-or-nothing) — a malformed DENY never yields a partial set', async () => {
    registerAccessControlPorts({
      policyRead: stubPort([
        denyRow(), // perfectly valid…
        denyRow({
          id: '66666666-6666-6666-6666-666666666666',
          rule: { conditions: [{ attribute: 'resource.amount', operator: 'not-an-operator', value: 1 }] },
        }),
      ]),
    });
    await expect(dbPolicies(ACTION)(principal)).rejects.toThrow(/POLICY_LOAD_FAILED/);
  });

  it('a malformed ALLOW row ALSO fails the load — silently dropping it would empty the allow-gate (fail open)', async () => {
    registerAccessControlPorts({
      policyRead: stubPort([
        denyRow({ id: '77777777-7777-7777-7777-777777777777', effect: 'allow', rule: { scope: 'own_only' } }),
      ]),
    });
    await expect(dbPolicies(ACTION)(principal)).rejects.toThrow(/POLICY_LOAD_FAILED/);
  });

  it('composes with the legacy leg: combinePolicies(dbPolicies, amountCapPolicies) concatenates both rule sets', async () => {
    registerAccessControlPorts({ policyRead: stubPort([denyRow()]) });
    const capped: AccessShape.Principal = { ...principal, attributes: { approvalLimit: 500 } };

    const combined = combinePolicies(dbPolicies(ACTION), amountCapPolicies(ACTION));
    const rules = await combined(capped);

    expect(rules.map((r) => r.id)).toEqual([
      '11111111-1111-1111-1111-111111111111', // the persisted DB rule first (loader order)
      `amount-cap:${ACTION}:500`, // then the synthesized legacy amount-cap deny
    ]);
    expect(rules.every((r) => r.effect === 'deny')).toBe(true);
  });

  it('empty result is the SEMANTIC "no persisted policies" state: resolves [] (RBAC alone decides)', async () => {
    registerAccessControlPorts({ policyRead: stubPort([]) });
    await expect(dbPolicies(ACTION)(principal)).resolves.toEqual([]);
  });
});
