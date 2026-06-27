import type { Request, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { HttpHeaderKey, REQUIRED_REQUEST_HEADERS, type SourceService } from '@aegis/shared-enums';
import { RequestContext } from '../context/request-context';
import type { RequestContextData } from '../context/context.types';
import { ErrUtils } from '../errors/error-utils';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function header(req: Request, key: HttpHeaderKey): string | undefined {
  const v = req.headers[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Returns the header value or throws a validation error — fail-closed (never defaults to "UNKNOWN"). */
export function assertHeaderPresent(req: Request, key: HttpHeaderKey, label?: string): string {
  const value = header(req, key);
  if (!value || !value.trim()) {
    return ErrUtils.throwValidation(`Missing required header: ${label ?? key}`);
  }
  return value.trim();
}

export interface ContextMiddlewareOptions {
  /** Headers that MUST be present + non-empty. Default: [X-Tenant-Id, X-Correlation-Id]. */
  requiredHeaders?: HttpHeaderKey[];
  /** Only the gateway mints a correlation id when absent; internal services fail closed. */
  mintCorrelationIdIfAbsent?: boolean;
  /** Path prefixes that skip context + header validation entirely (e.g. ['/health', '/.well-known']). */
  excludePaths?: string[];
}

/**
 * Opens the AsyncLocalStorage scope and STRICTLY validates required headers (fail-closed).
 * Header keys come from the centralised HttpHeaderKey enum.
 */
export function contextMiddleware(opts: ContextMiddlewareOptions = {}): RequestHandler {
  const required = opts.requiredHeaders ?? [...REQUIRED_REQUEST_HEADERS];
  const exclude = opts.excludePaths ?? [];
  return (req, _res, next) => {
    if (exclude.some((p) => req.path.startsWith(p))) {
      return next();
    }
    let correlationId = header(req, HttpHeaderKey.CorrelationId);
    if (!correlationId && opts.mintCorrelationIdIfAbsent) {
      correlationId = randomUUID();
    }

    for (const key of required) {
      if (key === HttpHeaderKey.CorrelationId && correlationId) continue;
      assertHeaderPresent(req, key);
    }

    const tenantId = assertHeaderPresent(req, HttpHeaderKey.TenantId);
    if (!UUID_RE.test(tenantId)) {
      return next(ErrUtils.validation('Malformed X-Tenant-Id (expected UUID)'));
    }

    const authorization = header(req, HttpHeaderKey.Authorization);
    const seed: RequestContextData = {
      tenantId,
      correlationId: correlationId as string,
      caller: header(req, HttpHeaderKey.Caller),
      sourceService: header(req, HttpHeaderKey.SourceService) as SourceService | undefined,
      token: authorization?.replace(/^Bearer\s+/i, ''),
      requestUrl: req.originalUrl,
      ipAddress: req.ip,
      startedAt: Date.now(),
    };

    return RequestContext.run(seed, () => next());
  };
}
