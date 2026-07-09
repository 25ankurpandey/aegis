import { QueryTypes } from 'sequelize';
import {
  mapPolicyRows,
  registerAccessControlPorts,
  type PolicyReadPort,
  type PolicyRow,
} from '@aegis/access-control';
import { ErrUtils } from '@aegis/service-core';
import { TableName } from '@aegis/shared-enums';
import { getSequelize } from './connection';
import { withTenantTransaction } from './transaction';

/**
 * Shared-DB `PolicyReadPort` implementation (ABAC generalization Phase 1 —
 * docs/strategy/abac-generalization.md §2.1/§2.2, §3 Q6 option (a)).
 *
 * Aegis runs one process per service against ONE shared Postgres (§1.1), so the persisted-policy
 * read must execute inside the CONSUMING service's process. This is the sanctioned shape for that:
 * a model-free, raw, parameterized SELECT inside `withTenantTransaction` — exactly the
 * `feature-flags-reader` pattern — so RLS (FORCE + RESTRICTIVE, migration 0028) scopes every read
 * to the tenant. No Sequelize model, no import of user-management internals; policy SEMANTICS stay
 * in `@aegis/access-control` (this module only fetches rows and delegates validation to
 * `mapPolicyRows`).
 *
 * Query notes:
 *  - `permission IN ($2, '*')` — the PDP matches deny rules on `action === '*'`, so the wildcard
 *    bucket must ride along (§3 Q4); wildcard-allow rows are a `MappingError` downstream.
 *  - `is_active = true` — the one legitimate row drop (an administered state, §3 Q1).
 *  - `deleted_at IS NULL` — the `policies` model is paranoid (soft delete); a raw SELECT bypasses
 *    Sequelize's paranoid scoping, so the predicate is restated here explicitly.
 *  - `ORDER BY priority ASC, id ASC` — determinism at the source (the mapper re-sorts anyway).
 *
 * FAIL-CLOSED (§3 Q1/Q4/Q8): the fetched set is validated through `mapPolicyRows` with
 * all-or-nothing semantics — ANY unmappable row (either effect) throws a typed system error, which
 * the PEP's `authorizeAny` catch surfaces as a 5xx (generic client message, full server-side log).
 * Never return a partial set and never coerce an error to `[]`: for allow-gated actions an empty
 * list vacuously passes the PDP's allow-gate, turning a bad row into an authorization bypass.
 */
export const dbPolicyReadPort: PolicyReadPort = {
  async listActive(tenantId: string, permission: string): Promise<PolicyRow[]> {
    const rows = await withTenantTransaction(
      (t) =>
        getSequelize().query<PolicyRow>(
          `SELECT id, tenant_id, permission, effect, rule, priority, is_active
             FROM "${TableName.Policies}"
            WHERE tenant_id = $1
              AND permission IN ($2, '*')
              AND is_active = true
              AND deleted_at IS NULL
            ORDER BY priority ASC, id ASC`,
          { bind: [tenantId, permission], type: QueryTypes.SELECT, transaction: t },
        ),
      { tenantId },
    );

    // All-or-nothing load guard (§3 Q1/Q8): a persisted row that cannot map to a PolicyRule fails
    // the WHOLE load — a silently dropped deny fails open directly, a silently dropped allow fails
    // open by emptying the PDP's allow-gate. The 5xx (not 403) is deliberate: 403 = denied by
    // policy, 5xx = could not evaluate policy (§3 Q4).
    const { errors } = mapPolicyRows(rows);
    if (errors.length > 0) {
      throw ErrUtils.system(
        `POLICY_LOAD_FAILED: ${errors.length} unmappable persisted policies row(s) for permission '${permission}' — all-or-nothing load refused (docs/strategy/abac-generalization.md §3 Q1/Q8)`,
        { errors },
      );
    }
    return rows;
  },
};

/**
 * Registers {@link dbPolicyReadPort} into the `@aegis/access-control` per-process port registry.
 * Call from EVERY consuming service's bootstrap (expense, invoice, payroll AND user-management
 * alike — §2.2/§3 Q6): the read executes in the consuming service's process, so registering in
 * only one service leaves the port undefined everywhere else and `dbPolicies` fail-closes those
 * routes. Idempotent, like `registerDefaultFeatureFlagReader`.
 */
export function registerDbPolicyReadPort(): void {
  registerAccessControlPorts({ policyRead: dbPolicyReadPort });
}
