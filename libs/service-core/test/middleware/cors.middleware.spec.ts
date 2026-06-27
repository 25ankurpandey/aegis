import express from 'express';
import { corsMiddleware } from '../../src/middleware/cors.middleware';
import { inject } from '../helpers/inject';

interface Resp {
  status: number;
  headers: { get: (name: string) => string | null };
  body: string;
}

async function listen(
  configure: (app: express.Express) => void,
): Promise<{
  call: (path: string, init?: RequestInit) => Promise<Resp>;
  close: () => Promise<void>;
}> {
  const app = express();
  configure(app);
  app.get('/x', (_req, res) => res.json({ ok: true }));
  return {
    async call(path, init) {
      return inject(app, {
        method: init?.method ?? 'GET',
        path,
        headers: init?.headers as Record<string, string> | undefined,
      });
    },
    close: async () => undefined,
  };
}

describe('corsMiddleware (W2-13)', () => {
  it('short-circuits OPTIONS preflight with 204 and the allow headers', async () => {
    const http = await listen((app) => app.use(corsMiddleware({ allowedOrigins: '*' })));
    try {
      const res = await http.call('/x', { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-methods')).toContain('GET');
      expect(res.headers.get('access-control-allow-headers')).toContain('x-tenant-id');
    } finally {
      await http.close();
    }
  });

  it('echoes an allowed explicit origin and sets Vary: Origin', async () => {
    const http = await listen((app) =>
      app.use(corsMiddleware({ allowedOrigins: ['https://app.example.com'] })),
    );
    try {
      const res = await http.call('/x', { headers: { origin: 'https://app.example.com' } });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
      expect(res.headers.get('vary')).toBe('Origin');
    } finally {
      await http.close();
    }
  });

  it('does not set an allow-origin for a disallowed origin', async () => {
    const http = await listen((app) =>
      app.use(corsMiddleware({ allowedOrigins: ['https://allowed.com'] })),
    );
    try {
      const res = await http.call('/x', { headers: { origin: 'https://evil.com' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await http.close();
    }
  });

  it('with credentials echoes the origin (never a wildcard) + allow-credentials', async () => {
    const http = await listen((app) =>
      app.use(corsMiddleware({ allowedOrigins: '*', credentials: true })),
    );
    try {
      const res = await http.call('/x', { headers: { origin: 'https://app.example.com' } });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    } finally {
      await http.close();
    }
  });
});
