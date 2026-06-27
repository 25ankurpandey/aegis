import type { Request, RequestHandler, Response } from 'express';
import { HttpHeaderKey } from '@aegis/shared-enums';
import { CacheAdapter } from '../cache/cache-adapter';
import { Logger } from '../logging/logger';

/** What we persist for a completed mutating request so a retry can be replayed verbatim. */
interface StoredResponse {
  status: number;
  body: unknown;
  /** Stored so a replay can be distinguished and (optionally) audited. */
  storedAt: string;
}

export interface IdempotencyOptions {
  /** How long a stored response is replayable (seconds). Default: IDEMPOTENCY_TTL_SECONDS / 86400 (24h). */
  ttlSeconds?: number;
  /** HTTP methods guarded (mutating verbs). Default: POST, PUT, PATCH, DELETE. */
  methods?: string[];
  /** Path prefixes excluded entirely. Default: ['/health']. */
  excludePaths?: string[];
}

const DEFAULT_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const DEFAULT_EXCLUDE = ['/health'];
const DEFAULT_TTL_SECONDS = 86_400;

function readKey(req: Request): string | undefined {
  const v = req.headers[HttpHeaderKey.IdempotencyKey];
  const key = Array.isArray(v) ? v[0] : v;
  return key && key.trim() ? key.trim() : undefined;
}

/**
 * Idempotency-replay middleware. When a mutating request carries an `Idempotency-Key` header, the
 * FIRST successful (non-5xx) response is cached per `(tenant, key)` in the {@link CacheAdapter} and a
 * later retry with the same key is replayed verbatim (same status + body) instead of re-executing the
 * handler — so a client that retries after a network blip never double-applies a write.
 *
 * Scoping: the cache key is namespaced by `RequestContext.tenantId()` (via `CacheAdapter.tenantKey`)
 * so keys can never collide or replay across tenants. Requests without the header pass straight
 * through (idempotency is opt-in per the header's contract). 5xx responses are NOT stored — a server
 * error should be retryable. Replays are served from the response `finish` capture below.
 */
export function idempotencyMiddleware(opts: IdempotencyOptions = {}): RequestHandler {
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const methods = new Set((opts.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));
  const exclude = opts.excludePaths ?? DEFAULT_EXCLUDE;

  return async (req: Request, res: Response, next) => {
    if (!methods.has(req.method.toUpperCase())) return next();
    if (exclude.some((p) => req.path.startsWith(p))) return next();

    const key = readKey(req);
    if (!key) return next(); // opt-in: no key → normal handling

    const cacheKey = CacheAdapter.tenantKey('idem', key);

    let stored: StoredResponse | null = null;
    try {
      stored = await CacheAdapter.get<StoredResponse>(cacheKey);
    } catch (err) {
      // Cache unavailable: fail OPEN (process normally) rather than block writes. Log for visibility.
      Logger.warn('idempotency cache read failed; processing without replay', {
        error: (err as Error).message,
      });
    }

    if (stored) {
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(stored.status).json(stored.body);
      return;
    }

    // First time for this key: capture the response body, then persist on a successful finish.
    const originalJson = res.json.bind(res);
    let capturedBody: unknown;
    res.json = (body: unknown): Response => {
      capturedBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      // Only store SUCCESS (2xx/3xx/4xx-deterministic) — never 5xx (those should be retryable).
      if (res.statusCode >= 500) return;
      const record: StoredResponse = {
        status: res.statusCode,
        body: capturedBody,
        storedAt: new Date().toISOString(),
      };
      void CacheAdapter.set(cacheKey, record, ttl).catch((err) =>
        Logger.warn('idempotency cache write failed', { error: (err as Error).message }),
      );
    });

    return next();
  };
}
