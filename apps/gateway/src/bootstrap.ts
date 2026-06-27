import express, { type Request, type Response } from 'express';
import {
  Logger,
  applyCoreMiddleware,
  attachErrorHandler,
  Config,
  installSignalHandlers,
} from '@aegis/service-core';
import { proxyHandler } from './proxy';

/**
 * Composition root for the gateway (the donor index → bootstrap split). The gateway is plain Express
 * (no inversify / no controllers), so it builds the app directly: `/health` bypasses everything, then
 * the core middleware band mints the correlation id at the edge (and validates required context
 * headers), then the reverse-proxy forwards to the routed service, and finally the terminal error
 * handler. Downstream services re-enforce auth via their own PEP (defense in depth).
 */
function init(): void {
  const app = express();

  // Health bypasses everything.
  app.get('/health', (_req: Request, res: Response) =>
    res.json({ service: 'gateway', status: 'ok', uptime: process.uptime() }),
  );

  // The gateway mints the correlation id at the edge and validates required context headers.
  applyCoreMiddleware(app, { context: { excludePaths: ['/health'], mintCorrelationIdIfAbsent: true } });

  // Reverse-proxy: forward to the routed service with propagated context headers.
  app.use(proxyHandler);

  attachErrorHandler(app);

  const port = Config.int('PORT', 4000);
  const server = app.listen(port, () => Logger.info(`gateway listening on :${port}`));

  // Graceful shutdown: on SIGTERM/SIGINT stop accepting new connections and drain in-flight proxied
  // requests (server.close) before exiting, so a rolling deploy never severs a live forward.
  installSignalHandlers({ server });
}

try {
  init();
} catch (err) {
  Logger.error(err as Error, 'STARTUP_FAILED', 'SYSTEM');
  process.exit(1);
}
