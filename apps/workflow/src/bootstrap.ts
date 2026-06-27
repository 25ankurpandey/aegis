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
import { registerApprovalProviders, getApprovalContext } from '@aegis/approvals';
import { container } from './ioc/container';
import { loadProviders } from './ioc/loader';
import { getWorkflowContext } from './models/database-context';
import { registerBuiltinEngine } from './engine';
import { registerConsumers } from './consumers';
import { bindConnectorStores } from './consumers/connector-sync.consumer';
import { DbConnectorConfigStore } from './services/connector-config.store';
import { StaticConnectorConfigStore } from '@aegis/connectors';

/**
 * Register the common graceful-shutdown hooks (LIFO after any HTTP drain): tear down cache → bus → DB
 * so the DB pool closes last. `installSignals` is wired by `installSignalHandlers` — the API role gets
 * it through `startServer`; the worker role (no HTTP server) installs it explicitly below.
 */
function registerShutdownHooks(): void {
  onShutdown({ name: 'db.close', run: () => closeSequelize() });
  if (isKafkaBus()) onShutdown({ name: 'bus.stop', run: () => (getBus() as KafkaBus).stop() });
  onShutdown({ name: 'cache.quit', run: () => CacheAdapter.quit() });
}

/**
 * Composition root for workflow (the donor bootstrap pattern). Defines the rules-as-data models on
 * the shared connection, loads the engine registries + DI providers, and then forks by role:
 *
 *  - `PROCESS_TYPE=worker` → activate the bus BEFORE registering consumers (`initEventBus()` → KafkaBus
 *    when KAFKA_BROKERS is set, so the subscriptions land on Kafka), register the consumers, then
 *    `start()` the bus to connect + run them. This process runs ONLY the consumers (no HTTP) — it is the
 *    half that actually triggers workflow rules from cross-service domain events (SPEC §11.4).
 *  - otherwise (the API role) → build the HTTP app via the shared `createService(...)` helper (core
 *    middleware band + `/health` excluded from context/auth + the terminal error handler) and listen.
 */
async function init(): Promise<void> {
  getWorkflowContext(); // define rules-as-data models on the shared connection
  getApprovalContext(); // BUG-0001: define the shared approval-engine models on the same connection
  registerBuiltinEngine(); // field→validator + action-type→handler registries
  // BUG-0001: the worker's ApprovalCommand consumer applies rule-driven approval commands via the
  // shared `@aegis/approvals` engine, so its `@provideSingleton` decorators must be evaluated into the
  // process-global registry BEFORE `loadProviders()` runs its single `container.load(...)` — the same
  // reusable wiring the finance services use. Must NOT load the provider module a second time.
  registerApprovalProviders();
  loadProviders(); // bind controllers + services + repositories (+ the approval engine) into the container
  // Bind DB-backed connector config + durable sync-state in both API and worker roles. The API uses
  // the same store for health/reconcile operator calls; the worker uses it for async pushes.
  bindConnectorStores({ config: new DbConnectorConfigStore(new StaticConnectorConfigStore()) });

  if (Config.get('PROCESS_TYPE') === 'worker') {
    // Worker role: consumers only. A worker MUST have a real broker to consume from.
    Config.requireAll(['DATABASE_URL', 'AUTH_JWT_SECRET', 'KAFKA_BROKERS']);
    initEventBus(); // KafkaBus when KAFKA_BROKERS is set; in-process for single-process dev
    registerConsumers(); // subscribe to the domain trigger topics → auto-run rules
    // No HTTP server in the worker role, so install the SIGTERM/SIGINT handlers explicitly to drain +
    // stop the consumers (`bus.stop`) and close resources on shutdown.
    registerShutdownHooks();
    installSignalHandlers();
    if (isKafkaBus()) {
      await (getBus() as KafkaBus).start(); // connect + run the consumers (no HTTP)
      Logger.info('workflow worker running (kafka consumers)');
    } else {
      Logger.info('workflow worker running (in-process bus; no KAFKA_BROKERS)');
    }
    return;
  }

  // API role also publishes (e.g. engine actions over HTTP), so connect the producer here too.
  initEventBus();
  registerShutdownHooks(); // startServer installs the signal handlers that run these on SIGTERM
  const service = createService({
    container,
    serviceName: 'workflow',
    requiredEnv: ['DATABASE_URL', 'AUTH_JWT_SECRET'],
  });
  service.start(Config.int('PORT', 4005));
}

init().catch((err) => {
  Logger.error(err as Error, 'STARTUP_FAILED', 'SYSTEM');
  process.exit(1);
});
