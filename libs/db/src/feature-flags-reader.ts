import { QueryTypes } from 'sequelize';
import { FeatureFlags, type FeatureFlagReader, TENANT_FEATURES_TABLE } from '@aegis/service-core';
import { getSequelize } from './connection';
import { withTenantTransaction } from './transaction';

/**
 * The default {@link FeatureFlagReader}: reads one (tenant, flag) row from `tenant_features` and
 * returns its `enabled` column, or `undefined` when there is no row for that pair.
 *
 * `tenant_features` is tenant-scoped with FORCE + RESTRICTIVE Row-Level Security keyed on
 * `app.current_tenant` (migration 0010 / SPEC §11.5), so the read MUST run inside a tenant-scoped
 * transaction that sets that context — otherwise RLS hides every row and the lookup would always
 * return `undefined`. `withTenantTransaction` sets the RLS context to the explicit `tenantId`
 * (rather than the ambient request context) before the query runs, so this also works off the
 * request path (workers/consumers via `FeatureFlags.isEnabledForTenant`). RLS already constrains the
 * result to the tenant; the explicit `tenant_id = $1` predicate keeps the lookup correct and hits the
 * `tenant_features_tenant_flag_uq` unique index regardless of how the policy is configured.
 */
export const featureFlagReader: FeatureFlagReader = (tenantId, flag) =>
  withTenantTransaction(
    async (t) => {
      const rows = await getSequelize().query<{ enabled: boolean }>(
        `SELECT enabled FROM "${TENANT_FEATURES_TABLE}" WHERE tenant_id = $1 AND flag = $2 LIMIT 1`,
        { bind: [tenantId, flag], type: QueryTypes.SELECT, transaction: t },
      );
      return rows.length > 0 ? rows[0].enabled : undefined;
    },
    { tenantId },
  );

/**
 * Wires {@link featureFlagReader} into the `@aegis/service-core` {@link FeatureFlags} helper so that
 * `FeatureFlags.isEnabled(...)` resolves against the database in running services.
 *
 * Invoked once from the `@aegis/db` barrel, so simply importing the DB layer — which every
 * DB-backed service does at bootstrap (via its `models/context`) — makes the flag lookup live with
 * no per-service wiring. It is also exported so a service `bootstrap`/`main.ts` can call it
 * explicitly. Idempotent: re-registering installs the same reader (the previous one is replaced).
 */
export function registerDefaultFeatureFlagReader(): void {
  FeatureFlags.setReader(featureFlagReader);
}
