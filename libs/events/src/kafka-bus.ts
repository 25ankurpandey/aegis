import { randomUUID } from 'node:crypto';
import {
  Kafka,
  logLevel,
  type Consumer,
  type EachMessagePayload,
  type KafkaConfig,
  type Producer,
} from 'kafkajs';
import { RequestContext, Logger, Config } from '@aegis/service-core';
import type { EventBus, EventHandler } from './bus';
import type { EventEnvelope, EventTopic } from './topics';

export interface KafkaBusOptions {
  /** Comma-separated broker list, or an explicit array. Defaults to KAFKA_BROKERS / localhost:9092. */
  brokers?: string | string[];
  /** Kafka clientId; defaults to KAFKA_CLIENT_ID / 'aegis'. */
  clientId?: string;
  /** Consumer group id; defaults to KAFKA_GROUP_ID / SOURCE_SERVICE / 'aegis'. One per service role. */
  groupId?: string;
  /** Read from the earliest offset on first join (default false → latest). */
  fromBeginning?: boolean;
  /** Back-pressure: pause a topic's consumer once its in-memory queue exceeds this (default 100). */
  maxQueueSize?: number;
  /** Max handler retries before giving up and committing to avoid head-of-line blocking (default 3). */
  retryHandlerMaxNo?: number;
  /** Delay (ms) between handler retries (default 1000). */
  retryDelayMs?: number;
  /** kafkajs log level (default WARN). */
  logLevel?: keyof typeof logLevel;
}

interface QueuedMessage {
  topic: EventTopic;
  partition: number;
  offset: string;
  raw: string;
}

/** Suffix appended to a topic to form its dead-letter topic (e.g. `expense.approved.dlq`). */
export const DLQ_SUFFIX = '.dlq';

/** The dead-letter record published when a handler exhausts its retries (recoverable forensic trail). */
interface DeadLetterRecord {
  originalTopic: EventTopic;
  partition: number;
  offset: string;
  attempts: number;
  error: string;
  failedAt: string;
  envelope: unknown;
}

interface TopicConsumer {
  /** FIFO in-memory queue draining serially per topic (the reference async.queue pattern). */
  queue: QueuedMessage[];
  draining: boolean;
  paused: boolean;
}

function parseBrokers(brokers?: string | string[]): string[] {
  if (Array.isArray(brokers)) return brokers;
  const raw = brokers ?? (Config.get('KAFKA_BROKERS', 'localhost:9092') as string);
  return raw
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kafka transport for distributed deployments (kafkajs), modeled on the reference architecture's
 * kafka-client: a single shared producer (publish → producer.send to the topic) and one consumer
 * per subscribed topic with an async back-pressure queue (pause/resume), bounded handler retries with
 * exponential backoff, a dead-letter topic (`<topic>.dlq`) on retry exhaustion, and a
 * CommitManager-style at-least-once manual commit (commit only after the handler succeeds OR the
 * envelope has been dead-lettered).
 *
 * Reuses the existing EventEnvelope JSON contract: on consume it rebuilds the RequestContext
 * (tenantId, correlationId, sourceService) from the envelope exactly like the in-process bus, so
 * consumers run under the same context the producer was authorized under.
 *
 * Activated on every pod (producer-on-every-pod) by `initEventBus()` when `KAFKA_BROKERS` is set.
 * `subscribe()` only registers handlers (kept synchronous to match the EventBus contract); call
 * `start()` after all subscriptions are registered (worker role) to connect + run the consumers.
 */
export class KafkaBus implements EventBus {
  private readonly kafka: Kafka;
  private readonly groupId: string;
  private readonly fromBeginning: boolean;
  private readonly maxQueueSize: number;
  private readonly retryHandlerMaxNo: number;
  private readonly retryDelayMs: number;

  private producer?: Producer;
  private producerConnecting?: Promise<Producer>;
  private readonly handlers = new Map<EventTopic, EventHandler[]>();
  private readonly topicConsumers = new Map<EventTopic, TopicConsumer>();
  private consumer?: Consumer;
  private started = false;

  constructor(opts: KafkaBusOptions = {}) {
    const config: KafkaConfig = {
      clientId: opts.clientId ?? (Config.get('KAFKA_CLIENT_ID', 'aegis') as string),
      brokers: parseBrokers(opts.brokers),
      logLevel: logLevel[opts.logLevel ?? 'WARN'],
    };
    this.kafka = new Kafka(config);
    this.groupId =
      opts.groupId ??
      (Config.get('KAFKA_GROUP_ID', Config.get('SOURCE_SERVICE', 'aegis')) as string);
    this.fromBeginning = opts.fromBeginning ?? Config.bool('KAFKA_FROM_BEGINNING', false);
    this.maxQueueSize = opts.maxQueueSize ?? Config.int('KAFKA_MAX_QUEUE_SIZE', 100);
    this.retryHandlerMaxNo = opts.retryHandlerMaxNo ?? Config.int('KAFKA_RETRY_MAX', 3);
    this.retryDelayMs = opts.retryDelayMs ?? Config.int('KAFKA_RETRY_DELAY_MS', 1000);
  }

  /** Lazily connect a single shared producer. */
  private async ensureProducer(): Promise<Producer> {
    if (this.producer) return this.producer;
    if (!this.producerConnecting) {
      const producer = this.kafka.producer();
      this.producerConnecting = producer.connect().then(() => {
        this.producer = producer;
        Logger.info('kafka producer connected', { groupId: this.groupId });
        return producer;
      });
    }
    return this.producerConnecting;
  }

  async publish<T>(env: EventEnvelope<T>): Promise<void> {
    const producer = await this.ensureProducer();
    await producer.send({
      topic: env.topic,
      messages: [
        {
          // Partition key = tenant so a tenant's events keep ordering on one partition.
          key: env.tenantId || env.id,
          value: JSON.stringify(env),
          headers: {
            correlationId: env.correlationId || randomUUID(),
            tenantId: env.tenantId ?? '',
            ...(env.sourceService ? { sourceService: env.sourceService } : {}),
          },
        },
      ],
    });
  }

  subscribe<T>(topic: EventTopic, handler: EventHandler<T>): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler as EventHandler);
    this.handlers.set(topic, list);
  }

  /**
   * Connect + run one consumer subscribed to all topics for this worker. Idempotent. Call after all
   * `subscribe(...)` registrations (worker bootstrap). Manual commit (at-least-once) via the
   * per-topic queue drain.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const topics = [...this.handlers.keys()];
    if (topics.length === 0) return;

    const consumer = this.kafka.consumer({ groupId: this.groupId });
    this.consumer = consumer;

    await consumer.connect();
    for (const topic of topics) {
      const tc: TopicConsumer = { queue: [], draining: false, paused: false };
      this.topicConsumers.set(topic, tc);
      await consumer.subscribe({ topic, fromBeginning: this.fromBeginning });
    }

    await consumer.run({
      autoCommit: false,
      eachMessage: async (payload: EachMessagePayload) => {
        const topic = payload.topic as EventTopic;
        const tc = this.topicConsumers.get(topic);
        if (!tc) {
          Logger.warn('kafka message ignored for unsubscribed topic', { topic });
          return;
        }
        await this.enqueue(topic, tc, payload);
      },
    });
    Logger.info('kafka consumer running', { topics, groupId: this.groupId });
  }

  /** Disconnect producer + all consumers (graceful shutdown). */
  async stop(): Promise<void> {
    if (this.consumer) {
      try {
        await this.consumer.disconnect();
      } catch (err) {
        Logger.error(err as Error, 'KAFKA_STOP', 'consumer.disconnect');
      }
      this.consumer = undefined;
    }
    this.topicConsumers.clear();
    if (this.producer) {
      try {
        await this.producer.disconnect();
      } catch (err) {
        Logger.error(err as Error, 'KAFKA_STOP', 'producer.disconnect');
      }
      this.producer = undefined;
      this.producerConnecting = undefined;
    }
    this.started = false;
  }

  /** Push a message onto the topic's queue and apply back-pressure (pause when the queue is full). */
  private async enqueue(
    topic: EventTopic,
    tc: TopicConsumer,
    payload: EachMessagePayload,
  ): Promise<void> {
    tc.queue.push({
      topic,
      partition: payload.partition,
      offset: payload.message.offset,
      raw: payload.message.value?.toString() ?? '',
    });
    if (tc.queue.length > this.maxQueueSize && !tc.paused) {
      this.consumer?.pause([{ topic }]);
      tc.paused = true;
      Logger.warn('kafka consumer paused (back-pressure)', { topic, queued: tc.queue.length });
    }
    void this.drain(topic, tc);
  }

  /** Drain a topic's queue serially; commit each processed offset (manual, at-least-once). */
  private async drain(topic: EventTopic, tc: TopicConsumer): Promise<void> {
    if (tc.draining) return;
    const consumer = this.consumer;
    if (!consumer) return;
    tc.draining = true;
    try {
      while (tc.queue.length > 0) {
        const msg = tc.queue.shift() as QueuedMessage;
        await this.handleWithRetry(msg);
        // At-least-once: commit offset+1 once the handler succeeds OR (on exhaustion) AFTER the
        // envelope has been dead-lettered inside handleWithRetry — so a poison message is recoverable
        // from `<topic>.dlq` before its offset advances, never silently dropped.
        try {
          await consumer.commitOffsets([
            { topic: msg.topic, partition: msg.partition, offset: (Number(msg.offset) + 1).toString() },
          ]);
        } catch (err) {
          Logger.error(err as Error, 'KAFKA_COMMIT', msg.topic);
        }
      }
      if (tc.paused) {
        consumer.resume([{ topic }]);
        tc.paused = false;
        Logger.info('kafka consumer resumed', { topic });
      }
    } finally {
      tc.draining = false;
    }
  }

  /**
   * Run all handlers for a message under a rebuilt RequestContext, with bounded retry and exponential
   * backoff. On retry exhaustion the envelope is published to `<topic>.dlq` (with error + attempt +
   * partition/offset) BEFORE returning, so the caller's offset commit can never drop a poison message
   * without a recoverable forensic record. Then we return so the offset advances (no head-of-line block).
   */
  private async handleWithRetry(msg: QueuedMessage): Promise<void> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.dispatch(msg);
        return;
      } catch (err) {
        attempt += 1;
        const error = err as Error;
        Logger.error(error, 'EVENT_HANDLER', msg.topic, { attempt });
        if (attempt >= this.retryHandlerMaxNo) {
          await this.deadLetter(msg, attempt, error);
          return;
        }
        // Exponential backoff: retryDelayMs * 2^(attempt-1).
        await delay(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  /** Publish the failed envelope to `<topic>.dlq` so it is recoverable before the offset is committed. */
  private async deadLetter(msg: QueuedMessage, attempts: number, error: Error): Promise<void> {
    let envelope: unknown = msg.raw;
    try {
      envelope = msg.raw ? JSON.parse(msg.raw) : null;
    } catch {
      /* keep the raw string if it is not valid JSON */
    }
    const record: DeadLetterRecord = {
      originalTopic: msg.topic,
      partition: msg.partition,
      offset: msg.offset,
      attempts,
      error: error.message,
      failedAt: new Date().toISOString(),
      envelope,
    };
    const dlqTopic = `${msg.topic}${DLQ_SUFFIX}`;
    try {
      const producer = await this.ensureProducer();
      const env = envelope as EventEnvelope | null;
      await producer.send({
        topic: dlqTopic,
        messages: [
          {
            key: env?.tenantId || env?.id || msg.offset,
            value: JSON.stringify(record),
            headers: {
              originalTopic: msg.topic,
              error: error.message,
              attempts: String(attempts),
              ...(env?.correlationId ? { correlationId: env.correlationId } : {}),
              ...(env?.tenantId ? { tenantId: env.tenantId } : {}),
            },
          },
        ],
      });
      Logger.warn('event dead-lettered', { dlqTopic, offset: msg.offset, attempts });
    } catch (sendErr) {
      // DLQ publish itself failed — log loudly; the offset is NOT committed by us here, but the caller
      // will still commit to avoid an infinite head-of-line block. Surface it for alerting.
      Logger.error(sendErr as Error, 'KAFKA_DLQ_SEND', dlqTopic, { offset: msg.offset, attempts });
    }
  }

  /** Parse the envelope and run each subscribed handler inside the rebuilt context. */
  private async dispatch(msg: QueuedMessage): Promise<void> {
    if (!msg.raw) return;
    const env = JSON.parse(msg.raw) as EventEnvelope;
    const list = this.handlers.get(msg.topic) ?? [];
    for (const handler of list) {
      await RequestContext.run(
        {
          tenantId: env.tenantId,
          correlationId: env.correlationId,
          sourceService: env.sourceService as never,
          startedAt: Date.now(),
        },
        async () => handler(env),
      );
    }
  }
}
