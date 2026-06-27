import { Config, Logger, createService, onShutdown, CacheAdapter } from '@aegis/service-core';
import { closeSequelize } from '@aegis/db';
import { initPolicyReload, stopPolicyWatcher } from '@aegis/access-control';
import { initEventBus, isKafkaBus, getBus, KafkaBus } from '@aegis/events';
import { container } from './ioc/container';
import { loadProviders } from './ioc/loader';
import { getIdentityContext } from './models/database-context';
import { PUBLIC_PATHS } from './constants';

/**
 * Composition root for user-management (the donor bootstrap pattern). Defines the identity models on
 * the shared connection, loads the DI providers (controllers + services + repositories), builds the
 * app via the shared `createService(...)` helper (core middleware band + `/health` excluded from
 * context/auth + the terminal error handler), and starts listening.
 */
function init(): void {
  getIdentityContext(); // define identity models on the shared connection
  loadProviders(); // bind controllers + services + repositories into the container
  initEventBus(); // producer-on-every-pod: publish to Kafka when KAFKA_BROKERS is set (else in-process)

  // W5-03: subscribe this pod to the Casbin policy-reload bus so PAP mutations on ANY pod reach it
  // without a restart. Fail-open (no-op if Redis is down) and async — don't block the listener.
  void initPolicyReload();

  // Graceful-shutdown hooks. They run LIFO (reverse of registration) AFTER the HTTP listener drains,
  // so registering DB → bus → watcher → cache tears down cache → watcher → bus → DB: the DB pool
  // closes LAST, after the Kafka producer has stopped and the Redis connections have been quit.
  onShutdown({ name: 'db.close', run: () => closeSequelize() });
  if (isKafkaBus()) onShutdown({ name: 'bus.stop', run: () => (getBus() as KafkaBus).stop() });
  onShutdown({ name: 'policy-watcher.stop', run: () => stopPolicyWatcher() });
  onShutdown({ name: 'cache.quit', run: () => CacheAdapter.quit() });

  const service = createService({
    container,
    serviceName: 'user-management',
    // Identity provider: JWT signing secret is mandatory on top of the DB.
    requiredEnv: ['DATABASE_URL', 'AUTH_JWT_SECRET'],
    assertPep: { publicPaths: PUBLIC_PATHS },
  });
  service.start(Config.int('PORT', 4001));
}

try {
  init();
} catch (err) {
  Logger.error(err as Error, 'STARTUP_FAILED', 'SYSTEM');
  process.exit(1);
}
