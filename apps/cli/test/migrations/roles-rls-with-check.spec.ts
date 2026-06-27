/**
 * BUG-0009 regression — the `roles` RLS policy must use a DISTINCT, stricter WITH CHECK than its
 * USING predicate.
 *
 * USING intentionally admits the tenant's own custom roles AND the global (tenant_id NULL) system
 * roles for READ. If WITH CHECK is left to default to USING, a tenant session could WRITE a NULL-
 * tenant system role that every other tenant would then see (a cross-tenant escalation /
 * defense-in-depth gap). The fix gives `roles` an explicit WITH CHECK that forbids NULL-tenant writes
 * under a tenant context while leaving the broader USING (read) predicate intact.
 *
 * This runs 0001_identity's `up` against a fake QueryInterface that records the raw RLS DDL it emits,
 * then asserts on the captured CREATE POLICY for the roles table — no database required.
 */
import type { QueryInterface } from 'sequelize';
import { up as up0001 } from '../../src/migrations/0001_identity';

/** A QueryInterface stub that records every raw `sequelize.query` (the RLS DDL path). */
function makeRecorder(): { q: QueryInterface; sql: string[] } {
  const sql: string[] = [];
  const q = {
    createTable: jest.fn(async () => undefined),
    addIndex: jest.fn(async () => undefined),
    addConstraint: jest.fn(async () => undefined),
    sequelize: { query: jest.fn(async (stmt: string) => void sql.push(stmt)) },
  } as unknown as QueryInterface;
  return { q, sql };
}

describe('BUG-0009 — roles RLS WITH CHECK', () => {
  let sql: string[];
  beforeAll(async () => {
    const r = makeRecorder();
    await up0001({ context: r.q } as never);
    sql = r.sql;
  });

  it('creates the roles isolation policy with an explicit WITH CHECK', () => {
    const policy = sql.find((s) => /CREATE POLICY "roles_isolation" ON "roles"/.test(s));
    expect(policy).toBeDefined();
    expect(policy).toMatch(/WITH CHECK/);
  });

  it('the roles WITH CHECK is STRICTER than USING: it forbids NULL-tenant (system) role writes', () => {
    const policy = sql.find((s) => /CREATE POLICY "roles_isolation" ON "roles"/.test(s))!;
    // USING admits global system rows for READ ("tenant_id IS NULL OR ...").
    const using = policy.slice(policy.indexOf('USING'), policy.indexOf('WITH CHECK'));
    expect(using).toMatch(/tenant_id IS NULL/);
    // WITH CHECK must NOT admit NULL-tenant writes — it only allows the current tenant's own rows.
    const check = policy.slice(policy.indexOf('WITH CHECK'));
    expect(check).not.toMatch(/tenant_id IS NULL/);
    expect(check).toMatch(/tenant_id = current_setting\('app\.current_tenant', true\)::uuid/);
  });
});
