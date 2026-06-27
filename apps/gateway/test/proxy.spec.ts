import type { Request, Response } from 'express';
import { RequestContext } from '@aegis/service-core';
import { HttpHeaderKey } from '@aegis/shared-enums';
import { proxyHandler, upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS } from '../src/proxy';

/** Minimal Express Response double capturing status/headers/body. */
function mockRes(): Response & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
} {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
}

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function runWithCtx(fn: () => Promise<void> | void): Promise<void> | void {
  return RequestContext.run(
    { tenantId: TENANT_ID, correlationId: CORRELATION_ID, startedAt: Date.now() },
    fn,
  );
}

function req(path = '/expense/v1/reports'): Request {
  return { path, originalUrl: path, method: 'GET', headers: {}, body: undefined } as unknown as Request;
}

describe('gateway proxyHandler resilience (W2-04)', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
    delete process.env.GATEWAY_UPSTREAM_TIMEOUT_MS;
  });

  it('defaults the upstream timeout to 15000ms and honours the env override', () => {
    expect(upstreamTimeoutMs()).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
    process.env.GATEWAY_UPSTREAM_TIMEOUT_MS = '2500';
    expect(upstreamTimeoutMs()).toBe(2500);
  });

  it('returns 504 with the correlation id when the upstream aborts (timeout)', async () => {
    // Simulate the AbortController firing: fetch rejects with an AbortError.
    global.fetch = jest.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    process.env.GATEWAY_UPSTREAM_TIMEOUT_MS = '5'; // fire the abort quickly

    const res = mockRes();
    await runWithCtx(() => {
      proxyHandler(req(), res, () => undefined);
    });

    expect(res.statusCode).toBe(504);
    expect(res.headers[HttpHeaderKey.CorrelationId]).toBe(CORRELATION_ID);
    expect((res.body as { errors: Array<{ code: string; correlationId: string }> }).errors[0].code).toBe(
      'E_GATEWAY_TIMEOUT',
    );
    expect((res.body as { errors: Array<{ correlationId: string }> }).errors[0].correlationId).toBe(
      CORRELATION_ID,
    );
  });

  it('returns 503 when the upstream connection is refused (ECONNREFUSED)', async () => {
    const err = new TypeError('fetch failed');
    (err as TypeError & { cause?: { code: string } }).cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn().mockRejectedValue(err) as unknown as typeof fetch;

    const res = mockRes();
    await runWithCtx(() => {
      proxyHandler(req(), res, () => undefined);
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers[HttpHeaderKey.CorrelationId]).toBe(CORRELATION_ID);
    expect((res.body as { errors: Array<{ code: string }> }).errors[0].code).toBe('E_UPSTREAM_UNAVAILABLE');
  });

  it('returns 502 when the upstream host cannot be resolved/reached (ENOTFOUND)', async () => {
    const err = new TypeError('fetch failed');
    (err as TypeError & { cause?: { code: string } }).cause = { code: 'ENOTFOUND' };
    global.fetch = jest.fn().mockRejectedValue(err) as unknown as typeof fetch;

    const res = mockRes();
    await runWithCtx(() => {
      proxyHandler(req(), res, () => undefined);
    });

    expect(res.statusCode).toBe(502);
    expect((res.body as { errors: Array<{ code: string }> }).errors[0].code).toBe('E_BAD_GATEWAY');
  });

  it('streams the upstream response through unchanged on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{"ok":true}',
    }) as unknown as typeof fetch;

    const res = mockRes();
    await runWithCtx(() => {
      proxyHandler(req(), res, () => undefined);
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers[HttpHeaderKey.CorrelationId]).toBe(CORRELATION_ID);
  });

  it('404s an unknown route segment via next(err)', async () => {
    const next = jest.fn();
    const res = mockRes();
    await runWithCtx(() => {
      proxyHandler(req('/nope/v1/x'), res, next);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
