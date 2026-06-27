import { CacheAdapter } from '../../src/cache/cache-adapter';
import { RequestContext } from '../../src/context/request-context';

const TENANT = '11111111-1111-4111-8111-111111111111';

function withContext<T>(fn: () => T): T {
  return RequestContext.run(
    { tenantId: TENANT, correlationId: 'corr-cache', startedAt: Date.now() },
    fn,
  );
}

describe('CacheAdapter.tenantKey (cross-tenant key safety)', () => {
  it('namespaces a key with the active context tenant', () => {
    withContext(() => {
      expect(CacheAdapter.tenantKey('user', 42)).toBe(`t:${TENANT}:user:42`);
    });
  });

  it('keeps the same logical key distinct across tenants', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const a = withContext(() => CacheAdapter.tenantKey('user', 1));
    const b = RequestContext.run(
      { tenantId: other, correlationId: 'c', startedAt: Date.now() },
      () => CacheAdapter.tenantKey('user', 1),
    );
    expect(a).not.toBe(b);
  });

  it('accepts an explicit tenantId override for off-request-path callers', () => {
    expect(CacheAdapter.tenantKey({ tenantId: TENANT, parts: ['report', 'x'] })).toBe(
      `t:${TENANT}:report:x`,
    );
  });

  it('throws (fail-closed) when called outside a context scope with no override', () => {
    expect(() => CacheAdapter.tenantKey('user', 1)).toThrow();
  });
});

describe('CacheAdapter.quit (graceful-shutdown hook)', () => {
  it('is a no-op when no client was ever lazily created', async () => {
    await expect(CacheAdapter.quit()).resolves.toBeUndefined();
  });

  it('closes a created client via quit() and is idempotent', async () => {
    const fake = { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };
    (CacheAdapter as unknown as { client: unknown }).client = fake;

    await CacheAdapter.quit();
    expect(fake.quit).toHaveBeenCalledTimes(1);

    // Second call is a no-op (client cleared) — no throw, no double-quit.
    await CacheAdapter.quit();
    expect(fake.quit).toHaveBeenCalledTimes(1);
  });

  it('falls back to a hard disconnect when graceful quit rejects', async () => {
    const fake = { quit: jest.fn().mockRejectedValue(new Error('mid-flight')), disconnect: jest.fn() };
    (CacheAdapter as unknown as { client: unknown }).client = fake;

    await CacheAdapter.quit();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });
});
