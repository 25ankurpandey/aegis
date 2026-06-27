import { ErrUtils } from '../errors/error-utils';

/** Typed environment access. Real secrets come from the param store in non-local envs (see secrets.ts). */
export const Config = {
  get(key: string, fallback?: string): string | undefined {
    return process.env[key] ?? fallback;
  },
  require(key: string): string {
    const v = process.env[key];
    if (v === undefined || v === '') {
      throw ErrUtils.system(`Missing required config: ${key}`);
    }
    return v;
  },
  /**
   * Boot-time required-config gate. Validates that EVERY key is present + non-empty and throws a
   * single aggregated error listing all missing keys, so a service refuses to start (before binding
   * the port) rather than failing lazily on the first request that touches a missing key. Returns the
   * resolved map for convenience. Call from `init()` / `createService({ requiredEnv })`.
   */
  requireAll(keys: readonly string[]): Record<string, string> {
    const resolved: Record<string, string> = {};
    const missing: string[] = [];
    for (const key of keys) {
      const v = process.env[key];
      if (v === undefined || v === '') {
        missing.push(key);
      } else {
        resolved[key] = v;
      }
    }
    if (missing.length > 0) {
      throw ErrUtils.system(
        `Missing required config (${missing.length}): ${missing.join(', ')}`,
        { missing },
      );
    }
    return resolved;
  },
  int(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined || v === '') return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  },
  bool(key: string, fallback = false): boolean {
    const v = process.env[key];
    if (v === undefined) return fallback;
    return v === 'true' || v === '1';
  },
  isLocal(): boolean {
    return (process.env.AEGIS_ENV ?? 'local') === 'local';
  },
};
