import { newEnforcer, newModelFromString, type Enforcer } from 'casbin';
import { Config } from '@aegis/service-core';

/**
 * Casbin RBAC-with-domains model (string constant — no file on disk so it bundles cleanly into
 * the single deployment image and the unit tests). `dom` is the **tenantId**: a subject's grant
 * is scoped to a tenant domain, giving real per-tenant isolation (NOT a global `'*'` domain).
 *
 *   r = sub, dom, act          a request: "may <role-or-user> in <tenant> do <permission>?"
 *   p = sub, dom, act, eft     a policy:  "<role> in <tenant|*> is allowed/denied <permission>"
 *   g = _, _, _                grouping:  "<user> has <role> in <tenant>" (domain-scoped roles)
 *   e = some(where p.eft==allow)
 *   m = g(r.sub,p.sub,r.dom) && (p.dom==r.dom || p.dom=="*") && r.act==p.act
 *
 * A `p.dom == "*"` policy line lets a system role (e.g. owner) be reused across every tenant
 * without duplicating one policy row per tenant, while a tenant-specific custom role binds to
 * its own `dom = tenantId`. The request domain `r.dom` is always a concrete tenantId.
 */
export const CASBIN_MODEL = `
[request_definition]
r = sub, dom, act

[policy_definition]
p = sub, dom, act, eft

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && (p.dom == r.dom || p.dom == "*") && r.act == p.act
`.trim();

/** A p-policy row: role/user `sub`, tenant `dom` (or `*`), permission `act`, effect. */
export interface PolicyLine {
  sub: string;
  dom: string;
  act: string;
  eft?: 'allow' | 'deny';
}

/** A g-policy (grouping) row: `user` has `role` in tenant `dom`. */
export interface GroupingLine {
  user: string;
  role: string;
  dom: string;
}

/** Seed policies for an in-memory enforcer (unit tests / no-DB local runs). */
export interface EnforcerSeed {
  policies?: PolicyLine[];
  groupings?: GroupingLine[];
}

function buildModel() {
  return newModelFromString(CASBIN_MODEL);
}

/**
 * Production enforcer backed by Postgres via casbin-pg-adapter. Reads `DATABASE_URL`; policies
 * live in the `casbin` policy table (migration 0009_casbin), seeded from the role→permission
 * catalog (seeder 0003_casbin_policies). The adapter is imported lazily so unit tests never
 * pull in the pg driver.
 */
export async function createEnforcer(): Promise<Enforcer> {
  // Lazy require keeps `pg`/adapter off the unit-test path (createInMemoryEnforcer needs no DB).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PostgresAdapter = require('casbin-pg-adapter').default as {
    newAdapter(opts: { connectionString: string; migrate?: boolean }): Promise<unknown>;
  };
  const connectionString = Config.require('DATABASE_URL');
  const adapter = await PostgresAdapter.newAdapter({ connectionString, migrate: false });
  const enforcer = await newEnforcer(buildModel(), adapter as never);
  await enforcer.loadPolicy();
  return enforcer;
}

/**
 * In-memory enforcer for unit tests and no-DB local runs. Holds policy in the enforcer's own
 * in-memory model (no adapter, no DB) and is seeded via addPolicy/addGroupingPolicy. Identical
 * model + matcher as production, so a test that passes here proves the real authorization behavior
 * (allow/deny, tenant-domain isolation, role→permission) without Docker or a database.
 */
export async function createInMemoryEnforcer(seed: EnforcerSeed = {}): Promise<Enforcer> {
  const enforcer = await newEnforcer(buildModel());
  for (const p of seed.policies ?? []) {
    await enforcer.addPolicy(p.sub, p.dom, p.act, p.eft ?? 'allow');
  }
  for (const g of seed.groupings ?? []) {
    await enforcer.addGroupingPolicy(g.user, g.role, g.dom);
  }
  return enforcer;
}

/**
 * Thin wrapper over `enforcer.enforce` with the Aegis arg order `(subject, tenantId, permission)`.
 * Fail-closed: any error from the enforcer is treated as a deny.
 */
export async function enforce(
  enforcer: Enforcer,
  subject: string,
  tenantId: string,
  permission: string,
): Promise<boolean> {
  try {
    return await enforcer.enforce(subject, tenantId, permission);
  } catch {
    return false;
  }
}
