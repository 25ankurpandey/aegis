import type { PolicyRow } from './policy-row-mapper';

/**
 * Read-port interfaces + per-process registry for the DB-backed ABAC layer (ABAC generalization
 * Phase 0 — docs/strategy/abac-generalization.md §2.1/§2.2, §3 Q6/Q10).
 *
 * Aegis runs one process per service against ONE shared Postgres (§1.1): the policy/attribute reads
 * execute inside the CONSUMING service's process, so the concrete implementations must be registered
 * in EVERY consuming service's bootstrap (`registerAccessControlPorts(...)` beside e.g. expense's
 * `getApprovalContext()`), mirroring the `libs/db` feature-flag-reader register-at-bootstrap pattern.
 * Registering only in user-management would leave the port undefined in expense/invoice/payroll.
 *
 * Phase 0 ships the interfaces + registry only — no default implementation, no loader, no PEP hook.
 * An UNREGISTERED port reads as "feature dormant": the getters return `undefined` and Phase-0 callers
 * simply have nothing to consume. From Phase 1 on, a wired `dbPolicies` loader finding no port MUST
 * throw (request blocked, surfacing as 5xx per §3 Q4/Q6) — never fall back to `[]`, which for
 * allow-gated actions fails open (pdp.ts:47-50, 93-97).
 */

/** Tenant + permission scoped read of persisted `policies` rows (§2.1, §3 Q6). */
export interface PolicyReadPort {
  /**
   * All enforceable rows for `(tenantId, permission)` — implementations fetch `is_active = true`
   * rows whose `permission` is the requested one OR `'*'` (the PDP matches deny rules on
   * `action === '*'`), via an RLS-scoped read (the raw parameterized SELECT inside
   * `withTenantTransaction`, Q6 option (a)). Rows come back RAW; mapping/validation is the
   * `policy-row-mapper`'s job (all-or-nothing, §3 Q1/Q8).
   */
  listActive(tenantId: string, permission: string): Promise<PolicyRow[]>;
}

/** The PIP read port (§3 Q10): loads `principal.attributes` (teamIds, approvalLimit, managerOf). */
export interface AttributeReadPort {
  /** One batched, per-(tenant, user) attribute fetch (e.g. `team_members` via the shared DB). */
  load(tenantId: string, userId: string): Promise<Record<string, unknown>>;
}

export interface AccessControlPorts {
  policyRead?: PolicyReadPort;
  attributeRead?: AttributeReadPort;
}

/** Module-scoped registry — one per service process, installed at bootstrap. */
let ports: AccessControlPorts = {};

/**
 * Register the concrete port implementation(s) for THIS service process. Call it from every
 * consuming service's bootstrap (§2.2 — expense, invoice, payroll AND user-management alike).
 * Merges per key: a call providing only `policyRead` leaves a previously registered
 * `attributeRead` in place; re-registering a key replaces it (idempotent, like
 * `registerDefaultFeatureFlagReader`).
 */
export function registerAccessControlPorts(next: AccessControlPorts): void {
  if (next.policyRead) ports = { ...ports, policyRead: next.policyRead };
  if (next.attributeRead) ports = { ...ports, attributeRead: next.attributeRead };
}

/** The registered policy read port, or `undefined` while the feature is dormant/unregistered. */
export function getPolicyReadPort(): PolicyReadPort | undefined {
  return ports.policyRead;
}

/** The registered attribute (PIP) read port, or `undefined` while dormant/unregistered. */
export function getAttributeReadPort(): AttributeReadPort | undefined {
  return ports.attributeRead;
}

/** Test helper: drop all registered ports (back to the dormant state). */
export function resetAccessControlPorts(): void {
  ports = {};
}
