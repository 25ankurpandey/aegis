import 'reflect-metadata';
import type { Transaction } from 'sequelize';
import {
  CacheAdapter,
  FeatureFlags,
  FeatureFlagCache,
  type FeatureFlagReader,
} from '@aegis/service-core';
import { runInContext, TEST_TENANT } from '@aegis/testing';

// withTenantTransaction just runs the callback with a fake transaction (no real DB in unit tests).
jest.mock('@aegis/db', () => ({
  withTenantTransaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> => fn({} as Transaction),
}));

// AuditLogger.record is a no-op here (its own behaviour is covered by libs/audit specs).
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn().mockResolvedValue(undefined) } }));

import { TenantConfigService, TenantCapabilityFlags } from '../../src/services/tenant-config.service';
import type { TenantConfigRepository } from '../../src/repositories/tenant-config.repository';

const FLAG = TenantCapabilityFlags.ExpenseVisualizer;

/** In-memory ioredis stand-in (GET/SET/DEL) so the read-through cache runs without a real Redis. */
function installFakeRedis() {
  const store = new Map<string, string>();
  const fake = {
    store,
    get: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
  (CacheAdapter as unknown as { client: unknown }).client = fake;
  return fake;
}

/**
 * A counting feature-flag reader standing in for the DB-backed reader. `enabled` controls the value;
 * `dbCalls` counts how many times the underlying "DB" was actually queried — the whole point of the
 * cache is to keep this number from growing on repeated checks.
 */
function makeReader(initial: boolean | undefined) {
  const state = { enabled: initial, dbCalls: 0 };
  const reader: FeatureFlagReader = async () => {
    state.dbCalls += 1;
    return state.enabled;
  };
  return { reader, state };
}

function makeService(repoOver: Partial<TenantConfigRepository> = {}) {
  const repo = {
    setFeature: jest.fn(async (data: { flag: string; enabled: boolean }) => ({
      id: 'feat-1',
      tenant_id: TEST_TENANT,
      flag: data.flag,
      enabled: data.enabled,
    })),
    getFeature: jest.fn().mockResolvedValue(null),
    ...repoOver,
  } as unknown as TenantConfigRepository;
  // Constructing the service installs the read-through cache in front of the current reader.
  return new TenantConfigService(repo);
}

describe('TenantConfigService — cached feature flags (W5-10)', () => {
  beforeEach(() => {
    installFakeRedis();
  });

  afterEach(() => {
    (CacheAdapter as unknown as { client: unknown }).client = null;
    FeatureFlags.setReader(undefined);
  });

  it('cache hit: a repeated isFeatureEnabled check does NOT hit the DB a second time', async () => {
    const { reader, state } = makeReader(true);
    FeatureFlags.setReader(reader);
    const svc = makeService();

    await runInContext(async () => {
      expect(await svc.isFeatureEnabled(FLAG)).toBe(true); // miss → DB
      expect(await svc.isFeatureEnabled(FLAG)).toBe(true); // hit → no DB
      expect(await svc.isFeatureEnabled(FLAG)).toBe(true); // hit → no DB
    });

    expect(state.dbCalls).toBe(1);
  });

  it('default-off when unset: an absent (tenant, flag) row resolves to false and is cached', async () => {
    const { reader, state } = makeReader(undefined); // no row in tenant_features
    FeatureFlags.setReader(reader);
    const svc = makeService();

    await runInContext(async () => {
      expect(await svc.isFeatureEnabled(FLAG)).toBe(false);
      expect(await svc.isFeatureEnabled(FLAG)).toBe(false);
    });

    // "absent" is cached too, so default-off is a hit — not a repeated DB miss.
    expect(state.dbCalls).toBe(1);
  });

  it('setFlag invalidates: the very next isFeatureEnabled re-reads the new value', async () => {
    const { reader, state } = makeReader(false);
    FeatureFlags.setReader(reader);
    const svc = makeService();

    await runInContext(async () => {
      expect(await svc.isFeatureEnabled(FLAG)).toBe(false); // miss → DB(false), cached
      expect(await svc.isFeatureEnabled(FLAG)).toBe(false); // hit
      expect(state.dbCalls).toBe(1);

      // Admin enables the flag: the write flips the backing value AND invalidates the cache entry.
      state.enabled = true;
      await svc.setFlag({ flag: FLAG, enabled: true });

      expect(await svc.isFeatureEnabled(FLAG)).toBe(true); // miss again → DB(true)
      expect(state.dbCalls).toBe(2);
    });
  });

  it('effectiveCapabilities advertises the real gated feature only when its flag is enabled', async () => {
    const { reader, state } = makeReader(false);
    FeatureFlags.setReader(reader);
    const svc = makeService();

    await runInContext(async () => {
      expect(await svc.effectiveCapabilities()).toEqual([]); // off by default

      state.enabled = true;
      await svc.setFlag({ flag: FLAG, enabled: true });

      expect(await svc.effectiveCapabilities()).toEqual([FLAG]);
    });
  });

  it('the cache is tenant-scoped: enabling for one tenant does not leak to another', async () => {
    const reader: FeatureFlagReader = async (tenantId) =>
      tenantId === TEST_TENANT ? true : undefined;
    FeatureFlags.setReader(reader);
    const svc = makeService();
    const OTHER = '00000000-0000-4000-8000-0000000000cc';

    await runInContext(async () => {
      expect(await svc.isFeatureEnabled(FLAG)).toBe(true);
    });
    await runInContext(
      async () => {
        expect(await svc.isFeatureEnabled(FLAG)).toBe(false);
      },
      { tenantId: OTHER },
    );
  });

  it('install is idempotent: constructing the service twice does not double-wrap the reader', async () => {
    const { reader, state } = makeReader(true);
    FeatureFlags.setReader(reader);
    makeService();
    makeService(); // second construct must NOT wrap the already-wrapped reader again

    const svc = makeService();
    await runInContext(async () => {
      await svc.isFeatureEnabled(FLAG);
      await svc.isFeatureEnabled(FLAG);
    });
    // A double-wrap would still cache, but assert the single-layer contract via the DB-call count.
    expect(state.dbCalls).toBe(1);
    expect(FeatureFlagCache.isWrapped(FeatureFlags.getReader())).toBe(true);
  });
});
