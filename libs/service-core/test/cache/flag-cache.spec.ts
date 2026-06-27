import { FeatureFlagCache } from '../../src/cache/flag-cache';
import { CacheAdapter } from '../../src/cache/cache-adapter';
import { FeatureFlags, type FeatureFlagReader } from '../../src/config/feature-flags';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/**
 * Minimal in-memory stand-in for the ioredis client the CacheAdapter talks to. Supports the GET /
 * SET (with optional `EX` TTL) / DEL surface flag-cache uses, so the read-through path is exercised
 * without a real Redis. We don't assert on TTL semantics here — just on call routing + hit/miss.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

function installFakeRedis(): ReturnType<typeof fakeRedis> {
  const fake = fakeRedis();
  (CacheAdapter as unknown as { client: unknown }).client = fake;
  return fake;
}

describe('FeatureFlagCache (read-through, tenant-scoped)', () => {
  afterEach(() => {
    (CacheAdapter as unknown as { client: unknown }).client = null;
    FeatureFlags.setReader(undefined);
  });

  it('serves a repeat lookup from cache — the second read does NOT hit the DB reader', async () => {
    installFakeRedis();
    const inner = jest.fn<ReturnType<FeatureFlagReader>, Parameters<FeatureFlagReader>>(async () => true);
    const cached = FeatureFlagCache.wrap(inner);

    expect(await cached(TENANT_A, 'expense.visualizer')).toBe(true);
    expect(await cached(TENANT_A, 'expense.visualizer')).toBe(true);

    // 1st call = cache miss → DB; 2nd call = cache hit → no DB.
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('default-off when unset: caches "absent" so a missing row is also a hit and stays false', async () => {
    installFakeRedis();
    const inner = jest.fn<ReturnType<FeatureFlagReader>, Parameters<FeatureFlagReader>>(async () => undefined);
    const cached = FeatureFlagCache.wrap(inner);

    // undefined (no row) round-trips back to undefined for the helper's `?? false` default-off.
    expect(await cached(TENANT_A, 'never.set')).toBeUndefined();
    expect(await cached(TENANT_A, 'never.set')).toBeUndefined();

    // The "absent" sentinel is cached, so a missing row is NOT re-queried on every check.
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('caches an explicit false distinctly from absent (both are hits, both stay falsy)', async () => {
    installFakeRedis();
    const inner = jest.fn<ReturnType<FeatureFlagReader>, Parameters<FeatureFlagReader>>(async () => false);
    const cached = FeatureFlagCache.wrap(inner);

    expect(await cached(TENANT_A, 'payroll.beta')).toBe(false);
    expect(await cached(TENANT_A, 'payroll.beta')).toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('invalidate() drops the entry so the next read re-fetches the new value', async () => {
    installFakeRedis();
    let dbValue = false;
    const inner = jest.fn<ReturnType<FeatureFlagReader>, Parameters<FeatureFlagReader>>(async () => dbValue);
    const cached = FeatureFlagCache.wrap(inner);

    expect(await cached(TENANT_A, 'expense.visualizer')).toBe(false); // miss → DB(false), cached
    expect(await cached(TENANT_A, 'expense.visualizer')).toBe(false); // hit
    expect(inner).toHaveBeenCalledTimes(1);

    // Simulate setFlag: underlying value flips, then the cache is invalidated.
    dbValue = true;
    await FeatureFlagCache.invalidate(TENANT_A, 'expense.visualizer');

    expect(await cached(TENANT_A, 'expense.visualizer')).toBe(true); // miss again → DB(true)
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('is tenant-scoped: one tenant\'s cached flag never serves another tenant', async () => {
    installFakeRedis();
    const inner = jest.fn<ReturnType<FeatureFlagReader>, Parameters<FeatureFlagReader>>(
      async (tenantId) => tenantId === TENANT_A,
    );
    const cached = FeatureFlagCache.wrap(inner);

    expect(await cached(TENANT_A, 'expense.visualizer')).toBe(true);
    // Different tenant → different key → a real DB read (not TENANT_A's cached `true`).
    expect(await cached(TENANT_B, 'expense.visualizer')).toBe(false);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('fails soft to the DB reader when the cache read throws (never hides a flag)', async () => {
    const fake = installFakeRedis();
    fake.get.mockRejectedValueOnce(new Error('redis down'));
    const inner = jest.fn<ReturnType<FeatureFlagReader>, Parameters<FeatureFlagReader>>(async () => true);
    const cached = FeatureFlagCache.wrap(inner);

    expect(await cached(TENANT_A, 'expense.visualizer')).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  describe('install (idempotent wrap of the live FeatureFlags reader)', () => {
    it('wraps the registered reader and dedupes the DB call across two isEnabledForTenant checks', async () => {
      installFakeRedis();
      const inner = jest.fn<ReturnType<FeatureFlagReader>, Parameters<FeatureFlagReader>>(async () => true);
      FeatureFlags.setReader(inner);

      expect(FeatureFlagCache.install()).toBe(true); // newly installed

      expect(await FeatureFlags.isEnabledForTenant(TENANT_A, 'expense.visualizer')).toBe(true);
      expect(await FeatureFlags.isEnabledForTenant(TENANT_A, 'expense.visualizer')).toBe(true);
      expect(inner).toHaveBeenCalledTimes(1); // 2nd resolves from cache
    });

    it('is a no-op (returns false) when already wrapped — never double-wraps', () => {
      installFakeRedis();
      FeatureFlags.setReader(jest.fn(async () => true));
      expect(FeatureFlagCache.install()).toBe(true);
      expect(FeatureFlagCache.install()).toBe(false); // already wrapped
    });

    it('returns false (and warns) when no reader is registered', () => {
      FeatureFlags.setReader(undefined);
      expect(FeatureFlagCache.install()).toBe(false);
    });
  });
});
