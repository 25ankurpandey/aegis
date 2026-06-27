import { Config, Logger } from '@aegis/service-core';
import { getBus, setBus, type EventBus } from './bus';
import { KafkaBus } from './kafka-bus';

/**
 * Connect the producer transport on EVERY pod (the load-bearing deployment invariant).
 *
 * When `KAFKA_BROKERS` is configured, swap the in-process default for a `KafkaBus` so `getBus().publish()`
 * goes to Kafka from ALL roles — api/producer pods AND worker pods — not the empty in-process bus that
 * has no subscribers in a producer process. `KafkaBus` lazily connects its producer on first publish and
 * never starts consumers unless `start()` is called, so this is safe for api pods (producer only); worker
 * pods additionally `registerConsumers()` + `bus.start()`.
 *
 * When `KAFKA_BROKERS` is unset (single-process local dev), the in-process bus stays the default so a
 * producer and its consumers share one process.
 *
 * Idempotent: only swaps once. Returns the active bus.
 */
export function initEventBus(): EventBus {
  const brokers = Config.get('KAFKA_BROKERS');
  if (!brokers || brokers.trim() === '') {
    Logger.info('event bus: KAFKA_BROKERS unset — using in-process bus (single-process dev)');
    return getBus();
  }
  if (getBus() instanceof KafkaBus) return getBus();
  const bus = new KafkaBus({ brokers });
  setBus(bus);
  Logger.info('event bus: KafkaBus active (producer connected on this pod)', { brokers });
  return bus;
}

/** True when the active bus is the Kafka transport (worker bootstraps gate `start()` on this). */
export function isKafkaBus(): boolean {
  return getBus() instanceof KafkaBus;
}
