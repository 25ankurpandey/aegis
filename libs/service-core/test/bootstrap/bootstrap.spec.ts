import 'reflect-metadata';
import type { Application } from 'express';
import { Container } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { createService } from '../../src/bootstrap/bootstrap';
import { ErrUtils } from '../../src/errors/error-utils';
import { RequestContext } from '../../src/context/request-context';
import { inject } from '../helpers/inject';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CORR = 'corr-test-1';

@controller('/things')
class ThingsController {
  @httpGet('/')
  list(): { tenantId: string; correlationId: string } {
    // Proves the context scope is open inside the handler.
    return { tenantId: RequestContext.tenantId(), correlationId: RequestContext.correlationId() };
  }

  @httpGet('/boom')
  boom(): never {
    return ErrUtils.throwForbidden('nope');
  }
}

@controller('/health')
class HealthController {
  @httpGet('/')
  health(): { status: string } {
    return { status: 'ok' };
  }
}

/** Exercise the Express app in memory; no port binding needed for middleware tests. */
async function listen(app: Application): Promise<{
  call: (path: string, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}> {
  return {
    async call(path, headers = {}) {
      const res = await inject(app, { method: 'GET', path, headers });
      return { status: res.status, body: res.body };
    },
    close: async () => undefined,
  };
}

function buildApp(): Application {
  const container = new Container();
  container.bind(ThingsController).toSelf();
  container.bind(HealthController).toSelf();
  // These fixtures intentionally carry no PEP guards, so disable the fail-closed PEP assertion here;
  // the assertion itself is covered by pep-assertion.spec.ts.
  return createService({ container, serviceName: 'test-svc', assertPep: false }).app;
}

describe('createService', () => {
  it('returns { app, start }', () => {
    const container = new Container();
    container.bind(HealthController).toSelf();
    const svc = createService({ container, serviceName: 'test-svc', assertPep: false });
    expect(typeof svc.start).toBe('function');
    expect(svc.app).toBeDefined();
  });

  it('serves /health WITHOUT requiring context headers (default exclude)', async () => {
    const http = await listen(buildApp());
    try {
      const res = await http.call('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    } finally {
      await http.close();
    }
  });

  it('opens the request context for a normal route when headers are present', async () => {
    const http = await listen(buildApp());
    try {
      const res = await http.call('/things', { 'x-tenant-id': TENANT, 'x-correlation-id': CORR });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tenantId: TENANT, correlationId: CORR });
    } finally {
      await http.close();
    }
  });

  it('fails closed with the error envelope when required headers are missing', async () => {
    const http = await listen(buildApp());
    try {
      const res = await http.call('/things');
      expect(res.status).toBe(400);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].type).toBe('VALIDATION');
    } finally {
      await http.close();
    }
  });

  it('attaches the terminal error handler (envelope on thrown AppError)', async () => {
    const http = await listen(buildApp());
    try {
      const res = await http.call('/things/boom', { 'x-tenant-id': TENANT, 'x-correlation-id': CORR });
      expect(res.status).toBe(403);
      expect(res.body.errors[0].type).toBe('FORBIDDEN');
      expect(res.body.errors[0].correlationId).toBe(CORR);
    } finally {
      await http.close();
    }
  });

  it('runs a service-supplied configure() hook after core middleware', async () => {
    const container = new Container();
    container.bind(HealthController).toSelf();
    const svc = createService({
      container,
      serviceName: 'test-svc',
      assertPep: false,
      configure: (app) => app.get('/extra', (_req, res) => res.json({ extra: true })),
    });
    const http = await listen(svc.app);
    try {
      // configure() routes sit BEHIND the core middleware band, so the context headers are required.
      const guarded = await http.call('/extra');
      expect(guarded.status).toBe(400);

      const res = await http.call('/extra', { 'x-tenant-id': TENANT, 'x-correlation-id': CORR });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ extra: true });
    } finally {
      await http.close();
    }
  });
});
