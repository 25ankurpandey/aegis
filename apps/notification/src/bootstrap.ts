import {
  Config,
  Logger,
  createService,
  onShutdown,
  CacheAdapter,
  installSignalHandlers,
} from '@aegis/service-core';
import { closeSequelize } from '@aegis/db';
import { initEventBus, isKafkaBus, getBus, KafkaBus } from '@aegis/events';
import { container } from './ioc/container';
import { loadProviders } from './ioc/loader';
import { getNotificationContext } from './models/database-context';
import { registerConsumers } from './consumers/notification.consumer';

/**
 * Register the common graceful-shutdown hooks (LIFO after any HTTP drain): tear down cache → bus → DB
 * so the DB pool closes last. The API role installs the signal handlers via `startServer`; the worker
 * role (no HTTP server) installs them explicitly.
 */
function registerShutdownHooks(): void {
  onShutdown({ name: 'db.close', run: () => closeSequelize() });
  if (isKafkaBus()) onShutdown({ name: 'bus.stop', run: () => (getBus() as KafkaBus).stop() });
  onShutdown({ name: 'cache.quit', run: () => CacheAdapter.quit() });
}

/**
 * Composition root for notification (the donor bootstrap pattern). Defines the notification models on
 * the shared connection and loads the DI providers, then forks on `PROCESS_TYPE`:
 *
 *  - `worker` — activate the bus (`initEventBus()` → KafkaBus when KAFKA_BROKERS is set), register the
 *    topic→handler subscriptions, and `start()` the Kafka consumers. This is the event-only write path;
 *    notifications are produced ACROSS processes from the already-authorized domain events (SPEC §11.4).
 *    No HTTP server.
 *  - otherwise (`api`) — build the HTTP service via the shared `createService(...)` helper (core
 *    middleware band + `/health` excluded from context/auth + the terminal error handler) and listen.
 *    The in-app inbox reads/mark-read surface only; it does NOT consume events.
 */
async function init(): Promise<void> {
  getNotificationContext(); // define notification models on the shared connection
  loadProviders(); // bind controllers + services + repositories into the container

  if (Config.get('PROCESS_TYPE') === 'worker') {
    // Worker role: consumers only. A worker MUST have a real broker to consume from.
    Config.requireAll(['DATABASE_URL', 'AUTH_JWT_SECRET', 'KAFKA_BROKERS']);
    initEventBus(); // KafkaBus when KAFKA_BROKERS is set; in-process for single-process dev
    registerConsumers(); // subscribe to the already-authorized domain events (event-only write path)
    // No HTTP server in the worker role, so install the SIGTERM/SIGINT handlers explicitly to drain +
    // stop the consumers (`bus.stop`) and close resources on shutdown.
    registerShutdownHooks();
    installSignalHandlers();
    if (isKafkaBus()) {
      await (getBus() as KafkaBus).start(); // connect + run one consumer per subscribed topic (at-least-once)
      Logger.info('notification worker started (Kafka consumer role)');
    } else {
      Logger.info('notification worker started (in-process bus; no KAFKA_BROKERS)');
    }
    return;
  }

  registerShutdownHooks(); // startServer installs the signal handlers that run these on SIGTERM
  const service = createService({
    container,
    serviceName: 'notification',
    requiredEnv: ['DATABASE_URL', 'AUTH_JWT_SECRET'],
  });
  service.start(Config.int('PORT', 4006));
}

init().catch((err) => {
  Logger.error(err as Error, 'STARTUP_FAILED', 'SYSTEM');
  process.exit(1);
});
