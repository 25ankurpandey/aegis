import { Config, Logger, createService, onShutdown, CacheAdapter } from '@aegis/service-core';
import { closeSequelize } from '@aegis/db';
import { container } from './ioc/container';
import { loadProviders } from './ioc/loader';
import { getReportingContext } from './models/database-context';

/**
 * Composition root for reporting (the donor bootstrap pattern). Defines the reporting control models
 * on the shared connection, loads the DI providers (controllers + service + repositories), builds the
 * app via the shared `createService(...)` helper (core middleware band + `/health` excluded from
 * context/auth + the terminal error handler), and starts listening.
 */
function init(): void {
  getReportingContext(); // define reporting models on the shared connection
  loadProviders(); // bind controllers + service + repositories into the container

  // Graceful-shutdown hooks (LIFO after the listener drains): quit Redis, then close the DB pool last.
  // Reporting is read-mostly and does not publish, so there is no event bus to stop.
  onShutdown({ name: 'db.close', run: () => closeSequelize() });
  onShutdown({ name: 'cache.quit', run: () => CacheAdapter.quit() });

  const service = createService({
    container,
    serviceName: 'reporting',
    requiredEnv: ['DATABASE_URL', 'AUTH_JWT_SECRET'],
  });
  service.start(Config.int('PORT', 4004));
}

try {
  init();
} catch (err) {
  Logger.error(err as Error, 'STARTUP_FAILED', 'SYSTEM');
  process.exit(1);
}
