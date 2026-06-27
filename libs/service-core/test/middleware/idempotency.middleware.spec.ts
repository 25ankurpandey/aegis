import express from 'express';
import { idempotencyMiddleware } from '../../src/middleware/idempotency.middleware';
import { contextMiddleware } from '../../src/middleware/context.middleware';
import { CacheAdapter } from '../../src/cache/cache-adapter';
import { inject } from '../helpers/inject';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** In-memory CacheAdapter stand-in (no Redis in unit tests). */
function installFakeCache(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  jest.spyOn(CacheAdapter, 'get').mockImplementation(async (key: string) => {
    return (store.has(key) ? store.get(key) : null) as never;
  });
  jest
    .spyOn(CacheAdapter, 'set')
    .mockImplementation(async (key: string, value: unknown) => {
      store.set(key, value);
    });
  return store;
}

async function listen(app: express.Express): Promise<{
  call: (path: string, init?: RequestInit) => Promise<{ status: number; body: any; replayed: boolean }>;
  close: () => Promise<void>;
}> {
  return {
    async call(path, init = {}) {
      const res = await inject(app, {
        method: init.method ?? 'GET',
        path,
        headers: init.headers as Record<string, string> | undefined,
        body: init.body,
      });
      return {
        status: res.status,
        body: res.body,
        replayed: res.headers.get('idempotent-replayed') === 'true',
      };
    },
    close: async () => undefined,
  };
}

function buildApp(counter: { n: number }): express.Express {
  const app = express();
  app.use(express.json());
  app.use(contextMiddleware());
  app.use(idempotencyMiddleware());
  app.post('/orders', (_req, res) => {
    counter.n += 1;
    res.status(201).json({ orderId: counter.n });
  });
  app.get('/orders', (_req, res) => res.json({ list: [] }));
  return app;
}

const HEADERS = {
  'content-type': 'application/json',
  'x-tenant-id': TENANT,
  'x-correlation-id': 'corr-idem',
};

describe('idempotencyMiddleware (W2-11)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('replays the first response for a repeated (tenant,key) without re-running the handler', async () => {
    installFakeCache();
    const counter = { n: 0 };
    const http = await listen(buildApp(counter));
    try {
      const first = await http.call('/orders', {
        method: 'POST',
        headers: { ...HEADERS, 'idempotency-key': 'key-1' },
        body: '{}',
      });
      expect(first.status).toBe(201);
      expect(first.body).toEqual({ orderId: 1 });
      expect(first.replayed).toBe(false);

      const replay = await http.call('/orders', {
        method: 'POST',
        headers: { ...HEADERS, 'idempotency-key': 'key-1' },
        body: '{}',
      });
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual({ orderId: 1 }); // same body, NOT orderId:2
      expect(replay.replayed).toBe(true);
      expect(counter.n).toBe(1); // handler ran exactly once
    } finally {
      await http.close();
    }
  });

  it('does not collide across tenants for the same key', async () => {
    installFakeCache();
    const counter = { n: 0 };
    const http = await listen(buildApp(counter));
    const other = '22222222-2222-4222-8222-222222222222';
    try {
      const a = await http.call('/orders', {
        method: 'POST',
        headers: { ...HEADERS, 'idempotency-key': 'same' },
        body: '{}',
      });
      const b = await http.call('/orders', {
        method: 'POST',
        headers: { ...HEADERS, 'x-tenant-id': other, 'idempotency-key': 'same' },
        body: '{}',
      });
      expect(a.body.orderId).toBe(1);
      expect(b.body.orderId).toBe(2); // different tenant → handler ran again
      expect(b.replayed).toBe(false);
    } finally {
      await http.close();
    }
  });

  it('passes through when no Idempotency-Key header is present (opt-in)', async () => {
    installFakeCache();
    const counter = { n: 0 };
    const http = await listen(buildApp(counter));
    try {
      await http.call('/orders', { method: 'POST', headers: HEADERS, body: '{}' });
      await http.call('/orders', { method: 'POST', headers: HEADERS, body: '{}' });
      expect(counter.n).toBe(2); // no key → no replay
    } finally {
      await http.close();
    }
  });

  it('ignores non-mutating verbs (GET passes straight through)', async () => {
    const store = installFakeCache();
    const http = await listen(buildApp({ n: 0 }));
    try {
      const res = await http.call('/orders', {
        method: 'GET',
        headers: { ...HEADERS, 'idempotency-key': 'g1' },
      });
      expect(res.status).toBe(200);
      expect(store.size).toBe(0); // nothing cached for a GET
    } finally {
      await http.close();
    }
  });
});
