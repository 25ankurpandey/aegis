import {
  Config,
  Logger,
  createService,
  onShutdown,
  CacheAdapter,
  installSignalHandlers,
} from '@aegis/service-core';
import { closeSequelize } from '@aegis/db';
import { initEventBus, isKafkaBus, getBus, KafkaBus, initOutboxRelay, stopOutboxRelay } from '@aegis/events';
import { registerBuiltinConnectors } from '@aegis/connectors';
import { getApprovalContext } from '@aegis/approvals';
import { container } from './ioc/container';
import { loadProviders } from './ioc/loader';
import { getExpenseContext } from './models/database-context';
import { registerConsumers } from './consumers/approval-completed.consumer';
import { registerRecordUpdateConsumer } from './consumers/record-update.consumer';

/**
 * Composition root for expense (the donor bootstrap pattern). Defines the expense models on the
 * shared connection, registers the built-in ERP connectors used on report approval, loads the DI
 * providers (controllers + services + repositories), then forks on `PROCESS_TYPE`:
 *
 *  - `worker` — activate the bus (`initEventBus()` → KafkaBus when KAFKA_BROKERS is set) and register
 *    the `ApprovalCompleted` consumer (BUG-0005 stranded-record recovery), then `start()` the Kafka
 *    consumers. No HTTP server — this half advances stranded reports from the relayed event.
 *  - otherwise (the API role) — build the HTTP app via the shared `createService(...)` helper and
 *    listen; the in-process outbox relay drains staged events to the bus.
 */
async function init(): Promise<void> {
  getExpenseContext(); // define expense models on the shared connection
  getApprovalContext(); // define the shared approval-engine models on the same connection (the engine needs them)
  registerBuiltinConnectors(); // register the mock ERP connectors used on report approval
  loadProviders(); // bind controllers + services + repositories into the container

  if (Config.get('PROCESS_TYPE') === 'worker') {
    // Worker role: consumers only. A worker MUST have a real broker to consume from.
    Config.requireAll(['DATABASE_URL', 'AUTH_JWT_SECRET', 'KAFKA_BROKERS']);
    initEventBus(); // KafkaBus when KAFKA_BROKERS is set; in-process for single-process dev
    registerConsumers(); // subscribe to ApprovalCompleted → advance the stranded record from the event
    registerRecordUpdateConsumer(); // BUG-0003: subscribe to RecordUpdated → apply assign_team / add_tag
    // No HTTP server in the worker role, so install the SIGTERM/SIGINT handlers explicitly to drain +
    // stop the consumers (`bus.stop`) and close resources on shutdown.
    onShutdown({ name: 'db.close', run: () => closeSequelize() });
    if (isKafkaBus()) onShutdown({ name: 'bus.stop', run: () => (getBus() as KafkaBus).stop() });
    onShutdown({ name: 'cache.quit', run: () => CacheAdapter.quit() });
    installSignalHandlers();
    if (isKafkaBus()) {
      await (getBus() as KafkaBus).start(); // connect + run the consumers (no HTTP)
      Logger.info('expense worker running (kafka consumers)');
    } else {
      Logger.info('expense worker running (in-process bus; no KAFKA_BROKERS)');
    }
    return;
  }

  initEventBus(); // producer-on-every-pod: publish to Kafka when KAFKA_BROKERS is set (else in-process)
  // Transactional-outbox relay: drain staged events to the bus at-least-once. Runs in-process so dev
  // (in-process bus + same-process consumers) still delivers; OUTBOX_RELAY_ENABLED=false to opt a pod out.
  initOutboxRelay();

  // Graceful-shutdown hooks (LIFO after the listener drains): tear down relay → cache → bus → DB so the
  // DB pool closes last. Registered DB → bus → cache → relay to achieve that reverse order.
  onShutdown({ name: 'db.close', run: () => closeSequelize() });
  if (isKafkaBus()) onShutdown({ name: 'bus.stop', run: () => (getBus() as KafkaBus).stop() });
  onShutdown({ name: 'cache.quit', run: () => CacheAdapter.quit() });
  onShutdown({ name: 'outbox.relay.stop', run: () => stopOutboxRelay() });

  const service = createService({
    container,
    serviceName: 'expense',
    requiredEnv: ['DATABASE_URL', 'AUTH_JWT_SECRET'],
  });
  service.start(Config.int('PORT', 4002));
}

init().catch((err) => {
  Logger.error(err as Error, 'STARTUP_FAILED', 'SYSTEM');
  process.exit(1);
});
