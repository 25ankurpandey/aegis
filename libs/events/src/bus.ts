import { RequestContext, Logger, Config } from '@aegis/service-core';
import type { EventEnvelope, EventTopic } from './topics';
import type { PayloadOf } from './payloads';

export type EventHandler<T = unknown> = (env: EventEnvelope<T>) => Promise<void> | void;

export interface EventBus {
  publish<T extends EventTopic>(env: EventEnvelope<PayloadOf<T>>): Promise<void>;
  publish<T>(env: EventEnvelope<T>): Promise<void>;
  subscribe<T extends EventTopic>(topic: T, handler: EventHandler<PayloadOf<T>>): void;
  subscribe<T>(topic: EventTopic, handler: EventHandler<T>): void;
}

/**
 * In-process dead-letter sink. The default just logs (matching the Kafka DLQ's forensic intent in a
 * single process), but a host can override it to persist/park failed envelopes. Kept as a hook so the
 * in-process bus does NOT silently swallow handler errors after retry exhaustion.
 */
export type DeadLetterSink = (
  env: EventEnvelope,
  meta: { topic: EventTopic; attempts: number; error: Error },
) => Promise<void> | void;

let deadLetterSink: DeadLetterSink = (env, meta) => {
  Logger.error(meta.error, 'EVENT_DLQ', meta.topic, {
    eventId: env.id,
    tenantId: env.tenantId,
    correlationId: env.correlationId,
    attempts: meta.attempts,
  });
};

/** Override where retry-exhausted in-process events are dead-lettered (e.g. a durable table). */
export function setDeadLetterSink(sink: DeadLetterSink): void {
  deadLetterSink = sink;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default in-process bus (great for local dev + the single-image local run). Each handler runs
 * inside a fresh RequestContext rebuilt from the envelope, so tenant + correlation id propagate to
 * consumers exactly as on the HTTP path.
 *
 * Durability: a failing handler is retried up to `KAFKA_RETRY_MAX` (default 3) with `KAFKA_RETRY_DELAY_MS`
 * spacing; on exhaustion the envelope is dead-lettered via the DeadLetterSink (logged by default) — it
 * is NOT silently caught-and-dropped. This matches the Kafka transport's retry-then-DLQ semantics so a
 * local/dev failure leaves the same forensic trail a distributed failure would. Swap for KafkaBus in
 * distributed envs via `setBus`/`initEventBus`.
 */
export class InProcessBus implements EventBus {
  private handlers = new Map<EventTopic, EventHandler[]>();
  private readonly retryMax = Config.int('KAFKA_RETRY_MAX', 3);
  private readonly retryDelayMs = Config.int('KAFKA_RETRY_DELAY_MS', 1000);

  subscribe<T>(topic: EventTopic, handler: EventHandler<T>): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler as EventHandler);
    this.handlers.set(topic, list);
  }

  async publish<T>(env: EventEnvelope<T>): Promise<void> {
    const list = this.handlers.get(env.topic) ?? [];
    for (const handler of list) {
      await this.runWithRetry(env as EventEnvelope, handler);
    }
  }

  /** Run one handler under the rebuilt context with bounded retry-then-DLQ (no silent swallow). */
  private async runWithRetry(env: EventEnvelope, handler: EventHandler): Promise<void> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await RequestContext.run(
          {
            tenantId: env.tenantId,
            correlationId: env.correlationId,
            sourceService: env.sourceService as never,
            startedAt: Date.now(),
          },
          async () => handler(env),
        );
        return;
      } catch (err) {
        attempt += 1;
        const error = err as Error;
        Logger.error(error, 'EVENT_HANDLER', env.topic, { attempt });
        if (attempt >= this.retryMax) {
          await deadLetterSink(env, { topic: env.topic, attempts: attempt, error });
          return;
        }
        await delay(this.retryDelayMs);
      }
    }
  }
}

let bus: EventBus = new InProcessBus();

export function getBus(): EventBus {
  return bus;
}

/** Override the bus (e.g. with the Kafka transport) at composition time. */
export function setBus(next: EventBus): void {
  bus = next;
}
