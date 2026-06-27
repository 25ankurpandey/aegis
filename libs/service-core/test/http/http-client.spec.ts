import { ServiceName } from '@aegis/shared-enums';
import { HttpClient } from '../../src/http/http-client';
import { ErrUtils } from '../../src/errors/error-utils';

const ENV = { ...process.env };
const realFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpClient timeout + retry (W2-03)', () => {
  beforeAll(() => HttpClient.init(ServiceName.Gateway));

  beforeEach(() => {
    process.env = { ...ENV };
    process.env.EXPENSE_URL = 'http://expense.local';
    process.env.HTTP_CLIENT_RETRY_BACKOFF_MS = '1'; // keep tests fast
    process.env.HTTP_CLIENT_MAX_RETRIES = '2';
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...ENV };
  });

  it('returns the parsed body on a 2xx (no retry)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await HttpClient.call<{ ok: boolean }>(ServiceName.Expense, {
      method: 'GET',
      path: '/x',
      propagateContext: false,
    });
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an idempotent GET on 5xx then succeeds (bounded)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { e: 'down' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await HttpClient.call(ServiceName.Expense, {
      method: 'GET',
      path: '/x',
      propagateContext: false,
    });
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries+1 attempts on persistent 5xx', async () => {
    // Fresh Response per call — a Response body can only be consumed once.
    const fetchMock = jest.fn().mockImplementation(async () => jsonResponse(500, { e: 'boom' }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      HttpClient.call(ServiceName.Expense, { method: 'GET', path: '/x', propagateContext: false }),
    ).rejects.toBeInstanceOf(Error);
    // 1 initial + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-idempotent POST', async () => {
    const fetchMock = jest.fn().mockImplementation(async () => jsonResponse(500, { e: 'boom' }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      HttpClient.call(ServiceName.Expense, { method: 'POST', path: '/x', propagateContext: false }),
    ).rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a POST when explicitly flagged retryable (idempotency-key dedupes)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { e: 'x' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await HttpClient.call(ServiceName.Expense, {
      method: 'POST',
      path: '/x',
      propagateContext: false,
      retryable: true,
    });
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx client error (other than 429)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(404, { e: 'nope' }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      HttpClient.call(ServiceName.Expense, { method: 'GET', path: '/x', propagateContext: false }),
    ).rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts and surfaces a timeout error when the downstream hangs', async () => {
    global.fetch = jest.fn((_url, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    }) as unknown as typeof fetch;

    await expect(
      HttpClient.call(ServiceName.Expense, {
        method: 'GET',
        path: '/slow',
        propagateContext: false,
        timeoutMs: 10,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('surfaces an AppError carrying the upstream status in details', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(404, { msg: 'gone' })) as unknown as typeof fetch;
    try {
      await HttpClient.call(ServiceName.Expense, {
        method: 'GET',
        path: '/x',
        propagateContext: false,
        maxRetries: 0,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(ErrUtils.isAppError(err)).toBe(true);
      expect((err as { details?: { status?: number } }).details?.status).toBe(404);
    }
  });
});
