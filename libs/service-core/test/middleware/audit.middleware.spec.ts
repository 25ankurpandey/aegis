import express from 'express';
import { auditMiddleware, type HttpAuditRecord } from '../../src/middleware/audit.middleware';
import { contextMiddleware } from '../../src/middleware/context.middleware';
import { inject } from '../helpers/inject';

const TENANT = '11111111-1111-4111-8111-111111111111';

async function listen(app: express.Express): Promise<{
  call: (path: string, headers?: Record<string, string>) => Promise<number>;
  close: () => Promise<void>;
}> {
  return {
    async call(path, headers = {}) {
      const res = await inject(app, { method: 'GET', path, headers });
      return res.status;
    },
    close: async () => undefined,
  };
}

describe('auditMiddleware (W2-12)', () => {
  it('captures method/path/status/duration + identity from context', async () => {
    const records: HttpAuditRecord[] = [];
    const app = express();
    app.use(contextMiddleware());
    app.use(auditMiddleware({ sink: (r) => records.push(r) }));
    app.get('/things', (_req, res) => res.json({ ok: true }));

    const http = await listen(app);
    try {
      const status = await http.call('/things', {
        'x-tenant-id': TENANT,
        'x-correlation-id': 'corr-audit',
        'x-caller': 'web',
      });
      expect(status).toBe(200);
      expect(records).toHaveLength(1);
      const rec = records[0];
      expect(rec.method).toBe('GET');
      expect(rec.path).toBe('/things');
      expect(rec.status).toBe(200);
      expect(rec.correlationId).toBe('corr-audit');
      expect(rec.tenantId).toBe(TENANT);
      expect(rec.caller).toBe('web');
      expect(typeof rec.durationMs).toBe('number');
    } finally {
      await http.close();
    }
  });

  it('excludes /health by default', async () => {
    const records: HttpAuditRecord[] = [];
    const app = express();
    app.use(auditMiddleware({ sink: (r) => records.push(r) }));
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    const http = await listen(app);
    try {
      await http.call('/health');
      expect(records).toHaveLength(0);
    } finally {
      await http.close();
    }
  });

  it('never records the Authorization header (only safe metadata)', async () => {
    const records: HttpAuditRecord[] = [];
    const app = express();
    app.use(contextMiddleware());
    app.use(auditMiddleware({ sink: (r) => records.push(r) }));
    app.get('/secure', (_req, res) => res.json({ ok: true }));

    const http = await listen(app);
    try {
      await http.call('/secure', {
        'x-tenant-id': TENANT,
        'x-correlation-id': 'c',
        authorization: 'Bearer super-secret',
      });
      const serialized = JSON.stringify(records[0]);
      expect(serialized).not.toContain('super-secret');
      expect(serialized).not.toContain('authorization');
    } finally {
      await http.close();
    }
  });
});
