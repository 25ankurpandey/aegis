import type { Request, Response } from 'express';
import { controller, httpGet } from 'inversify-express-utils';
import { CacheAdapter } from '@aegis/service-core';
import { pingDb } from '@aegis/db';

/** Liveness/readiness. `/health` is excluded from context + auth middleware. */
@controller('/health')
export class HealthController {
  @httpGet('/')
  async health(req: Request, res: Response): Promise<void> {
    const base = { service: 'reporting', status: 'ok', uptime: process.uptime() };
    if (req.query['details'] !== 'true') {
      res.status(200).json(base);
      return;
    }
    const [db, cache] = await Promise.all([pingDb(), CacheAdapter.ping()]);
    const ok = db && cache;
    res.status(ok ? 200 : 503).json({ ...base, status: ok ? 'ok' : 'degraded', db, cache });
  }
}
