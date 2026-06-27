import { RequestContext } from '../context/request-context';
import { Logger } from '../logging/logger';

/**
 * The physical table feature flags are stored in (per-tenant feature toggles).
 * Created/owned by user-management's migrations. Kept as a literal here so this helper
 * does not need to depend on `@aegis/db` or the model layer (which depend on `@aegis/service-core`),
 * avoiding a dependency cycle.
 */
export const TENANT_FEATURES_TABLE = 'tenant_features';

/**
 * Reads one feature flag row from `tenant_features` for a tenant. Returns whether the flag is
 * enabled, or `undefined` when there is no row for that (tenant, flag) pair.
 *
 * Provided by `@aegis/db` (or the service bootstrap) via {@link FeatureFlags.setReader}, so this
 * config helper stays free of any database dependency and unit tests run without a real DB. When no
 * reader is registered the helper degrades gracefully to "flag disabled".
 */
export type FeatureFlagReader = (tenantId: string, flag: string) => Promise<boolean | undefined>;

/**
 * Per-tenant feature-flag helper (SPEC §11.5). Gate a capability with:
 *
 *   if (await FeatureFlags.isEnabled('expense.visualizer')) { ... }
 *
 * The flag is resolved for the CURRENT request's tenant (from `RequestContext`). It is fail-soft:
 * any missing context, missing reader, missing row, or lookup error resolves to `false` so a flag
 * lookup can never take a request down. Use an explicit tenant via `isEnabledForTenant` off the
 * request path (workers/consumers that manage their own scope).
 */
export class FeatureFlags {
  private static reader: FeatureFlagReader | undefined;

  /**
   * Registers the backing reader (called once at bootstrap by the DB layer). Passing `undefined`
   * clears it (used by tests). Replacing an existing reader is allowed.
   */
  static setReader(reader: FeatureFlagReader | undefined): void {
    FeatureFlags.reader = reader;
  }

  /** True only if a reader is wired; useful for diagnostics/health. */
  static hasReader(): boolean {
    return FeatureFlags.reader !== undefined;
  }

  /**
   * The currently-registered reader, or `undefined` when none is wired. Exposed so a decorator (e.g.
   * the read-through {@link FeatureFlagCache}) can wrap the live reader at bootstrap without owning a
   * back-reference to it.
   */
  static getReader(): FeatureFlagReader | undefined {
    return FeatureFlags.reader;
  }

  /**
   * Whether `flag` is enabled for the current request's tenant. Defaults to `false` if there is no
   * active request context, no reader, no matching row, or the lookup fails.
   */
  static async isEnabled(flag: string): Promise<boolean> {
    const tenantId = RequestContext.tryGet()?.tenantId;
    if (!tenantId) {
      return false;
    }
    return FeatureFlags.isEnabledForTenant(tenantId, flag);
  }

  /**
   * Whether `flag` is enabled for an explicit `tenantId` (for non-request paths). Defaults to
   * `false` if no reader is registered, no row exists, or the lookup fails.
   */
  static async isEnabledForTenant(tenantId: string, flag: string): Promise<boolean> {
    const reader = FeatureFlags.reader;
    if (!reader) {
      return false;
    }
    try {
      const enabled = await reader(tenantId, flag);
      return enabled ?? false;
    } catch (err) {
      Logger.error(
        err instanceof Error ? err : new Error(String(err)),
        'FEATURE_FLAG_LOOKUP',
        'FeatureFlags',
        { flag, tenantId },
      );
      return false;
    }
  }
}
