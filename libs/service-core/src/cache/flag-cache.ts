import { CacheAdapter } from './cache-adapter';
import { Config } from '../config/config';
import { FeatureFlags, type FeatureFlagReader } from '../config/feature-flags';
import { Logger } from '../logging/logger';

/** Brands a reader returned by {@link FeatureFlagCache.wrap} so `install()` never double-wraps it. */
const WRAPPED: unique symbol = Symbol('aegis.featureFlagCache.wrapped');

/**
 * Read-through cache for per-tenant feature flags (W5-10).
 *
 * `TenantConfigService.isFeatureEnabled` and {@link FeatureFlags.isEnabled} both ultimately resolve a
 * (tenant, flag) pair against the database. On a hot path that meant a fresh `withTenantTransaction`
 * + DB round-trip on EVERY check. This wraps any backing {@link FeatureFlagReader} with a tiny
 * tenant-scoped cache so a repeated lookup for the same (tenant, flag) is served from Redis (or, when
 * Redis is unavailable, fails soft straight through to the DB reader).
 *
 * Cross-tenant safety: keys are namespaced via the explicit-tenant form of
 * {@link CacheAdapter.tenantKey} (`t:<tenantId>:ff:<flag>`), so a flag value can never collide or
 * leak across tenants — and it works OFF the request path (the reader is handed an explicit
 * `tenantId`, so we never read the ambient context here).
 *
 * Correctness on writes: a cache is only safe if it is invalidated when the underlying value changes.
 * `TenantConfigService.setFlag` calls {@link FeatureFlagCache.invalidate} after persisting, so the
 * very next read re-fetches and re-warms. A short TTL is a backstop (bounds staleness if a write ever
 * happens on a path that forgets to invalidate, e.g. a direct SQL change).
 *
 * Encoding: a present flag is cached as the boolean; an ABSENT (tenant, flag) row is cached as the
 * sentinel string `'__absent__'` so "default-off because unset" is also a cache hit (not a repeated
 * DB miss). Both encodings round-trip back to the `boolean | undefined` reader contract.
 */
export class FeatureFlagCache {
  /** Distinguishes a cached "no row exists" from a cached `false` (a row that is explicitly off). */
  private static readonly ABSENT = '__absent__';

  /** Cache namespace segment, e.g. `t:<tenantId>:ff:<flag>`. */
  private static readonly NS = 'ff';

  private static cachedValue<T>(raw: unknown): raw is T {
    return raw !== null && raw !== undefined;
  }

  private static key(tenantId: string, flag: string): string {
    return CacheAdapter.tenantKey({ tenantId, parts: [FeatureFlagCache.NS, flag] });
  }

  /** Cache TTL (seconds). Override with `FEATURE_FLAG_CACHE_TTL_SECONDS`; defaults to 5 minutes. */
  static ttlSeconds(): number {
    return Config.int('FEATURE_FLAG_CACHE_TTL_SECONDS', 300);
  }

  /**
   * Wrap a backing reader with the read-through cache. The returned reader is a drop-in
   * {@link FeatureFlagReader}: on a hit it returns the cached value without touching `inner`; on a
   * miss it calls `inner`, caches the result (including "absent"), and returns it. Cache errors are
   * fail-soft — any Redis hiccup logs and falls through to `inner`, so the cache can never take a
   * flag lookup (and therefore a request) down.
   */
  static wrap(inner: FeatureFlagReader): FeatureFlagReader {
    const cached: FeatureFlagReader & { [WRAPPED]?: true } = async (tenantId, flag) => {
      const key = FeatureFlagCache.key(tenantId, flag);

      try {
        const hit = await CacheAdapter.get<boolean | string>(key);
        if (FeatureFlagCache.cachedValue<boolean | string>(hit)) {
          return hit === FeatureFlagCache.ABSENT ? undefined : (hit as boolean);
        }
      } catch (err) {
        Logger.error(
          err instanceof Error ? err : new Error(String(err)),
          'FEATURE_FLAG_CACHE_READ',
          'FeatureFlagCache',
          { flag, tenantId },
        );
        // fall through to the DB reader — do not let a cache fault hide the flag
      }

      const value = await inner(tenantId, flag);

      try {
        await CacheAdapter.set(
          key,
          value === undefined ? FeatureFlagCache.ABSENT : value,
          FeatureFlagCache.ttlSeconds(),
        );
      } catch (err) {
        Logger.error(
          err instanceof Error ? err : new Error(String(err)),
          'FEATURE_FLAG_CACHE_WRITE',
          'FeatureFlagCache',
          { flag, tenantId },
        );
        // best-effort warm — a failed write just means the next read is another miss
      }

      return value;
    };
    cached[WRAPPED] = true;
    return cached;
  }

  /** Whether `reader` is already a {@link FeatureFlagCache.wrap}-produced reader (idempotency guard). */
  static isWrapped(reader: FeatureFlagReader | undefined): boolean {
    return reader !== undefined && (reader as { [WRAPPED]?: true })[WRAPPED] === true;
  }

  /**
   * Drop the cached entry for one (tenant, flag) pair so the next read re-fetches from the DB. Called
   * by `TenantConfigService.setFlag` after a write commits. Fail-soft: a delete error logs and is
   * swallowed — the TTL still bounds staleness, so a transient Redis fault can't wedge a stale flag
   * permanently (and certainly can't fail the write).
   */
  static async invalidate(tenantId: string, flag: string): Promise<void> {
    try {
      await CacheAdapter.del(FeatureFlagCache.key(tenantId, flag));
    } catch (err) {
      Logger.error(
        err instanceof Error ? err : new Error(String(err)),
        'FEATURE_FLAG_CACHE_INVALIDATE',
        'FeatureFlagCache',
        { flag, tenantId },
      );
    }
  }

  /**
   * Install the read-through cache in front of the {@link FeatureFlags} helper's current reader. Call
   * AFTER the DB layer has registered its reader (`registerDefaultFeatureFlagReader`) so the cache
   * wraps the live DB reader. No-op (logs + returns `false`) when no reader is registered yet, and
   * FULLY IDEMPOTENT: if the current reader is already a wrapped one it leaves it in place (returns
   * `false`) rather than double-wrapping. Returns `true` only when it newly installed the wrapper, so
   * a lazy caller can install-once safely from a hot path.
   */
  static install(): boolean {
    const reader = FeatureFlags.getReader();
    if (!reader) {
      Logger.warn('No feature-flag reader registered; skipping cache install', {
        errType: 'FEATURE_FLAG_CACHE',
      });
      return false;
    }
    if (FeatureFlagCache.isWrapped(reader)) {
      return false;
    }
    FeatureFlags.setReader(FeatureFlagCache.wrap(reader));
    return true;
  }
}
