import { type RequestHandler } from 'express';
import { Config, ErrUtils, Logger, RequestContext } from '@aegis/service-core';
import { HttpHeaderKey } from '@aegis/shared-enums';
import { ROUTES } from './routes-config';

/** Default upstream request budget (ms) before the gateway aborts the call and returns 504. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;

/** Resolve the configurable per-hop upstream timeout (`GATEWAY_UPSTREAM_TIMEOUT_MS`, default 15000). */
export function upstreamTimeoutMs(): number {
  return Config.int('GATEWAY_UPSTREAM_TIMEOUT_MS', DEFAULT_UPSTREAM_TIMEOUT_MS);
}

/** Node's fetch surfaces connection failures (refused/reset/unreachable host) via `error.cause.code`. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
]);

function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code ?? (err as { code?: string }).code;
}

/**
 * Reverse-proxy handler: resolves the first path segment to a target service, forwards the request
 * with the propagated context headers (tenant id + correlation id + caller, and the bearer token
 * when present), and streams the upstream response back. Each downstream service re-validates auth
 * via its own PEP (defense in depth), so the gateway only routes — it does not authorize.
 *
 * Resilience (W2-04): every upstream call carries a configurable timeout budget
 * (`GATEWAY_UPSTREAM_TIMEOUT_MS`, default 15000). On expiry the call is aborted and the gateway
 * returns `504 Gateway Timeout`; when the upstream refuses/resets/cannot be resolved the gateway
 * returns `502 Bad Gateway` (or `503 Service Unavailable` on connection refused) — it never hangs on
 * a slow or dead dependency. The minted/propagated `X-Correlation-Id` is echoed on every such
 * response so a failed hop stays traceable end-to-end.
 */
export const proxyHandler: RequestHandler = async (req, res, next) => {
  const segment = req.path.split('/')[1];
  const route = ROUTES[segment];
  if (!route) {
    return next(ErrUtils.notFound(`No route for /${segment}`));
  }
  const base = Config.get(route.env, route.defaultUrl) as string;
  const ctx = RequestContext.get();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [HttpHeaderKey.TenantId]: ctx.tenantId,
    [HttpHeaderKey.CorrelationId]: ctx.correlationId,
    [HttpHeaderKey.Caller]: 'gateway',
  };
  if (ctx.token) headers[HttpHeaderKey.Authorization] = `Bearer ${ctx.token}`;

  // Always echo the correlation id back so even an error hop is traceable.
  res.set(HttpHeaderKey.CorrelationId, ctx.correlationId);

  const timeoutMs = upstreamTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const upstream = await fetch(`${base}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: hasBody && req.body ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.set('content-type', upstream.headers.get('content-type') ?? 'application/json');
    res.send(text);
  } catch (err) {
    // Timeout: the AbortController fired → 504 Gateway Timeout (never hang on a slow upstream).
    if (controller.signal.aborted || (err as Error)?.name === 'AbortError') {
      Logger.warn('gateway upstream timeout', {
        svc: route.svc,
        timeoutMs,
        correlationId: ctx.correlationId,
      });
      respondGatewayError(res, 504, 'E_GATEWAY_TIMEOUT', `Upstream ${route.svc} timed out`, ctx.correlationId);
      return;
    }
    // Unreachable/refused/reset → 503 on a refused connection, 502 otherwise. Never hang.
    const code = errorCode(err);
    const status = code === 'ECONNREFUSED' ? 503 : UNREACHABLE_CODES.has(code ?? '') ? 502 : 502;
    Logger.error(err as Error, 'GATEWAY_UPSTREAM', route.svc, {
      code,
      status,
      correlationId: ctx.correlationId,
    });
    respondGatewayError(
      res,
      status,
      status === 503 ? 'E_UPSTREAM_UNAVAILABLE' : 'E_BAD_GATEWAY',
      `Upstream ${route.svc} unreachable`,
      ctx.correlationId,
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Emit the gateway error envelope (matching the service-core terminal error shape) directly, with the
 * correct gateway status code (502/503/504) the typed AppError map cannot express, and the
 * correlation id both as a response header (already set) and inside the body.
 */
function respondGatewayError(
  res: Parameters<RequestHandler>[1],
  status: number,
  code: string,
  message: string,
  correlationId: string,
): void {
  if (res.headersSent) return;
  res.status(status).json({
    errors: [{ code, type: 'GATEWAY', message, correlationId }],
  });
}
