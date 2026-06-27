import Redis from 'ioredis';
import { Config } from '../config/config';
import { RequestContext } from '../context/request-context';

/**
 * Redis-backed cache seam.
 *
 * Cross-tenant safety: in a multi-tenant RLS platform a raw, unscoped cache key is a data-leak
 * footgun — two tenants computing the same logical key (e.g. `user:123`) would collide and read each
 * other's cached value. `tenantKey(...)` namespaces every key with the active `RequestContext.tenantId()`
 * so entries can never collide or leak across tenants. The `getT/setT/delT` helpers force that scoping;
 * prefer them over the raw `get/set/del` (which remain for already-namespaced / cross-tenant ops keys).
 */
export class CacheAdapter {
  private static client: Redis | null = null;

  static init(url = Config.get('REDIS_URL', 'redis://localhost:6379')): void {
    CacheAdapter.client = new Redis(url as string, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  private static conn(): Redis {
    if (!CacheAdapter.client) {
      CacheAdapter.init();
    }
    return CacheAdapter.client as Redis;
  }

  /**
   * Build a tenant-namespaced key from one or more parts, e.g. `tenantKey('user', id)` →
   * `t:<tenantId>:user:<id>`. Reads the tenant from the active RequestContext (fail-closed: throws
   * outside a context scope), or from an explicit `tenantId` override for off-request-path callers
   * (workers/consumers that already know the tenant). Parts are stringified and joined with `:`.
   */
  static tenantKey(...parts: Array<string | number>): string;
  static tenantKey(opts: { tenantId: string; parts: Array<string | number> }): string;
  static tenantKey(
    first: string | number | { tenantId: string; parts: Array<string | number> },
    ...rest: Array<string | number>
  ): string {
    let tenantId: string;
    let parts: Array<string | number>;
    if (typeof first === 'object') {
      tenantId = first.tenantId;
      parts = first.parts;
    } else {
      tenantId = RequestContext.tenantId();
      parts = [first, ...rest];
    }
    if (!tenantId) {
      throw new Error('CacheAdapter.tenantKey requires a tenantId (none on context)');
    }
    return ['t', tenantId, ...parts.map((p) => String(p))].join(':');
  }

  static async get<T>(key: string): Promise<T | null> {
    const raw = await CacheAdapter.conn().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  static async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (ttlSeconds) {
      await CacheAdapter.conn().set(key, raw, 'EX', ttlSeconds);
    } else {
      await CacheAdapter.conn().set(key, raw);
    }
  }

  static async del(key: string): Promise<void> {
    await CacheAdapter.conn().del(key);
  }

  /** Tenant-scoped get: namespaces `parts` by the active tenant before reading. */
  static getT<T>(...parts: Array<string | number>): Promise<T | null> {
    return CacheAdapter.get<T>(CacheAdapter.tenantKey(...parts));
  }

  /** Tenant-scoped set: namespaces `parts` by the active tenant before writing. */
  static setT(parts: Array<string | number>, value: unknown, ttlSeconds?: number): Promise<void> {
    return CacheAdapter.set(CacheAdapter.tenantKey(...parts), value, ttlSeconds);
  }

  /** Tenant-scoped delete: namespaces `parts` by the active tenant before deleting. */
  static delT(...parts: Array<string | number>): Promise<void> {
    return CacheAdapter.del(CacheAdapter.tenantKey(...parts));
  }

  static async ping(): Promise<boolean> {
    try {
      return (await CacheAdapter.conn().ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Graceful shutdown: close the Redis connection if one was ever opened. Registered as an
   * `onShutdown` hook so a SIGTERM tears the cache client down cleanly (after the HTTP listener has
   * drained). Best-effort + idempotent — a no-op when the lazily-connected client was never created,
   * and falls back to a hard `disconnect()` if the graceful `quit()` rejects.
   */
  static async quit(): Promise<void> {
    const client = CacheAdapter.client;
    if (!client) return;
    CacheAdapter.client = null;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}
