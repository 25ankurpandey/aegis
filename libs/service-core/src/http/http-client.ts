import { HttpHeaderKey, ServiceName, type SourceService } from '@aegis/shared-enums';
import { RequestContext } from '../context/request-context';
import { Config } from '../config/config';
import { ErrUtils } from '../errors/error-utils';
import { signInternalToken } from '../auth/internal-auth';

/** Maps a target service to the env var holding its base URL (set in each service's .env). */
const SERVICE_URL_ENV: Record<ServiceName, string> = {
  [ServiceName.Gateway]: 'GATEWAY_URL',
  [ServiceName.UserManagement]: 'USER_MANAGEMENT_URL',
  [ServiceName.Expense]: 'EXPENSE_URL',
  [ServiceName.Payroll]: 'PAYROLL_URL',
  [ServiceName.Reporting]: 'REPORTING_URL',
  [ServiceName.Workflow]: 'WORKFLOW_URL',
  [ServiceName.Notification]: 'NOTIFICATION_URL',
  [ServiceName.Invoice]: 'INVOICE_URL',
};

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
  headers?: Record<string, string>;
  propagateContext?: boolean;
  idempotencyKey?: string;
  /** Per-call timeout override (ms). Falls back to HTTP_CLIENT_TIMEOUT_MS / 5000. */
  timeoutMs?: number;
  /** Per-call max retry attempts override (only honored for idempotent verbs / when explicitly retryable). */
  maxRetries?: number;
  /**
   * Force this call to be treated as retryable even if the verb is not idempotent. Only set this for
   * a write you KNOW is safe to retry (e.g. it carries an Idempotency-Key the server dedupes on).
   */
  retryable?: boolean;
}

/** HTTP verbs that are safe to retry by default (idempotent per RFC 7231). */
const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'DELETE']);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Context-propagating service-to-service client. Resolves target base URL from the registry. */
export class HttpClient {
  private static selfService: SourceService = ServiceName.Gateway;

  static init(selfService: SourceService): void {
    HttpClient.selfService = selfService;
  }

  private static propagatedHeaders(): Record<string, string> {
    const ctx = RequestContext.tryGet();
    const headers: Record<string, string> = {
      [HttpHeaderKey.SourceService]: HttpClient.selfService,
      [HttpHeaderKey.InternalOrigin]: Config.get('INTERNAL_ORIGIN', 'aegis-internal') as string,
      [HttpHeaderKey.InternalToken]: signInternalToken(HttpClient.selfService),
    };
    if (ctx) {
      headers[HttpHeaderKey.TenantId] = ctx.tenantId;
      headers[HttpHeaderKey.CorrelationId] = ctx.correlationId;
      if (ctx.caller) headers[HttpHeaderKey.Caller] = ctx.caller;
      if (ctx.token) headers[HttpHeaderKey.Authorization] = `Bearer ${ctx.token}`;
    }
    return headers;
  }

  static async call<T>(target: ServiceName, req: HttpRequest): Promise<T> {
    const base = Config.get(SERVICE_URL_ENV[target]);
    if (!base) {
      throw ErrUtils.system(`No base URL configured for service ${target} (${SERVICE_URL_ENV[target]})`);
    }
    const url = new URL(req.path, base);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(req.propagateContext === false ? {} : HttpClient.propagatedHeaders()),
      ...(req.idempotencyKey ? { [HttpHeaderKey.IdempotencyKey]: req.idempotencyKey } : {}),
      ...req.headers,
    };

    const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
    const timeoutMs = req.timeoutMs ?? Config.int('HTTP_CLIENT_TIMEOUT_MS', 5000);
    // Retry only idempotent verbs (or an explicitly-flagged retryable call). A POST is NOT retried by
    // default — replaying a non-idempotent write could double-apply it.
    const retryable = req.retryable ?? IDEMPOTENT_METHODS.has(req.method);
    const maxRetries = retryable
      ? req.maxRetries ?? Config.int('HTTP_CLIENT_MAX_RETRIES', 2)
      : 0;
    const backoffMs = Config.int('HTTP_CLIENT_RETRY_BACKOFF_MS', 100);

    let attempt = 0;
    // Total tries = 1 initial + maxRetries.
    for (;;) {
      try {
        return await HttpClient.fetchOnce<T>(target, url, req.method, headers, body, timeoutMs);
      } catch (err) {
        const isRetryable = retryable && HttpClient.isRetryableError(err);
        if (!isRetryable || attempt >= maxRetries) {
          throw err;
        }
        attempt += 1;
        // Exponential backoff: backoffMs * 2^(attempt-1).
        await delay(backoffMs * 2 ** (attempt - 1));
      }
    }
  }

  /** A single attempt: bounded by an AbortController timeout so a hung downstream cannot pin a request. */
  private static async fetchOnce<T>(
    target: ServiceName,
    url: URL,
    method: HttpMethod,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw ErrUtils.system(`Service ${target} request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw ErrUtils.system(`Service ${target} responded ${res.status}`, {
        status: res.status,
        body: parsed,
      });
    }
    return parsed as T;
  }

  /**
   * Retry only on transient failures: timeouts/network errors and upstream 5xx / 429. A 4xx (other
   * than 429) is a client error and replaying it will just fail again, so we do not retry it.
   */
  private static isRetryableError(err: unknown): boolean {
    if (ErrUtils.isAppError(err)) {
      const details = err.details as { status?: number } | undefined;
      const status = details?.status;
      // Timeouts surface with no status; treat them as retryable.
      if (status === undefined) return true;
      return status >= 500 || status === 429;
    }
    // Bare network/abort errors (e.g. ECONNREFUSED) — retryable.
    return true;
  }
}
