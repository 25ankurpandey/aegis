import type { Request, RequestHandler } from 'express';
import { HttpHeaderKey } from '@aegis/shared-enums';
import { Config } from '../config/config';

export interface CorsOptions {
  /**
   * Allowed origins. `'*'` allows any (but NOT with credentials — see below). An explicit list is
   * matched exactly against the request `Origin`. Defaults to `CORS_ALLOWED_ORIGINS` (comma-separated)
   * or `'*'` locally.
   */
  allowedOrigins?: string[] | '*';
  /** Allowed methods. Defaults to the standard REST set. */
  allowedMethods?: string[];
  /** Allowed request headers. Defaults to the Aegis context headers + content-type. */
  allowedHeaders?: string[];
  /** Whether to allow credentials (cookies/Authorization). Forces an echoed origin, never `*`. */
  credentials?: boolean;
  /** Preflight cache lifetime (seconds). Defaults to 600. */
  maxAgeSeconds?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_HEADERS = [
  'content-type',
  HttpHeaderKey.Authorization,
  HttpHeaderKey.TenantId,
  HttpHeaderKey.CorrelationId,
  HttpHeaderKey.Caller,
  HttpHeaderKey.IdempotencyKey,
];

function resolveAllowedOrigins(opt?: string[] | '*'): string[] | '*' {
  if (opt) return opt;
  const raw = Config.get('CORS_ALLOWED_ORIGINS');
  if (!raw) return '*';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function pickOrigin(req: Request, allowed: string[] | '*'): string | undefined {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return allowed === '*' ? '*' : undefined;
  if (allowed === '*') return origin; // echo when credentials may be enabled; '*' otherwise
  return allowed.includes(origin) ? origin : undefined;
}

/**
 * Explicit CORS middleware for browser-facing entrypoints (the gateway / any service mounted for a
 * browser). Sits in the band BEFORE routes. Short-circuits `OPTIONS` preflight with 204. When
 * `credentials` is on it never emits a wildcard origin (that combination is rejected by browsers);
 * it echoes the matched origin instead and sets `Vary: Origin` so caches don't bleed across origins.
 */
export function corsMiddleware(opts: CorsOptions = {}): RequestHandler {
  const allowed = resolveAllowedOrigins(opts.allowedOrigins);
  const methods = (opts.allowedMethods ?? DEFAULT_METHODS).join(', ');
  const headers = (opts.allowedHeaders ?? DEFAULT_HEADERS).join(', ');
  const credentials = opts.credentials ?? false;
  const maxAge = String(opts.maxAgeSeconds ?? 600);

  return (req, res, next) => {
    const origin = pickOrigin(req, allowed);
    if (origin) {
      // With credentials a literal '*' is invalid; echo the request origin instead.
      const value = credentials && origin === '*' ? (req.headers.origin as string) : origin;
      if (value) {
        res.setHeader('Access-Control-Allow-Origin', value);
        if (value !== '*') res.setHeader('Vary', 'Origin');
        if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    }
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
    res.setHeader('Access-Control-Max-Age', maxAge);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
