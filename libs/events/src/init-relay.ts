import { Config, Logger } from '@aegis/service-core';
import { OutboxRelay, type OutboxRelayOptions } from './outbox';

let relay: OutboxRelay | undefined;

/**
 * Start the transactional-outbox relay for this process (idempotent — returns the existing relay if
 * already started). The relay polls `event_outbox` and drains pending rows to the active bus
 * at-least-once.
 *
 * Where it runs:
 *  - Single-process / local dev (in-process bus): start it in EACH producer service so staged events
 *    still reach that process's in-process consumers. The poll is cheap (a single SKIP-LOCKED query).
 *  - Distributed: run a dedicated `PROCESS_TYPE=relay` process (or fold it into a worker) so exactly
 *    one role drains to Kafka. SKIP LOCKED makes running several relay instances safe (no double-send).
 *
 * Disable with `OUTBOX_RELAY_ENABLED=false` (e.g. on api pods that should not also relay).
 */
export function initOutboxRelay(opts: OutboxRelayOptions = {}): OutboxRelay | undefined {
  if (relay) return relay;
  if (!Config.bool('OUTBOX_RELAY_ENABLED', true)) {
    Logger.info('outbox relay disabled (OUTBOX_RELAY_ENABLED=false)');
    return undefined;
  }
  relay = new OutboxRelay(opts);
  relay.start();
  return relay;
}

/** Stop the process relay (graceful shutdown hook). */
export function stopOutboxRelay(): void {
  relay?.stop();
  relay = undefined;
}
