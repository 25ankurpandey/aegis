/**
 * KafkaBus DLQ test: when a handler exhausts its retries, the failed envelope must be published to
 * `<topic>.dlq` BEFORE the offset is committed, so a poison message is recoverable. We mock kafkajs
 * so no broker is needed: the fake consumer captures the `eachMessage` callback registered by
 * `start()`, and we drive one poison message through it.
 */

type SendCall = { topic: string; messages: Array<{ value: string; headers?: Record<string, unknown> }> };

const producerSend = jest.fn<Promise<void>, [SendCall]>().mockResolvedValue(undefined);
const commitOffsets = jest.fn().mockResolvedValue(undefined);
const consumerSubscribe = jest.fn().mockResolvedValue(undefined);
const consumerRun = jest.fn(async ({ eachMessage }: { eachMessage: (p: unknown) => Promise<void> }) => {
  capturedEachMessage = eachMessage;
});
const consumerFactory = jest.fn(() => ({
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  subscribe: consumerSubscribe,
  run: consumerRun,
  commitOffsets,
  pause: jest.fn(),
  resume: jest.fn(),
}));
let capturedEachMessage: ((p: unknown) => Promise<void>) | undefined;

jest.mock('kafkajs', () => {
  const logLevel = { ERROR: 1, WARN: 2, INFO: 4, DEBUG: 5 };
  return {
    logLevel,
    Kafka: class {
      producer() {
        return {
          connect: jest.fn().mockResolvedValue(undefined),
          disconnect: jest.fn().mockResolvedValue(undefined),
          send: producerSend,
        };
      }
      consumer() {
        return consumerFactory();
      }
    },
  };
});

// Import AFTER the mock is registered.
import { KafkaBus, DLQ_SUFFIX } from '../src/kafka-bus';
import { makeEnvelope, EventTopic, type EventEnvelope } from '../src/topics';
import { RequestContext } from '@aegis/service-core';

/** The drain loop runs detached (`void this.drain`); wait until the offset is committed (or timeout). */
async function waitForCommit(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (commitOffsets.mock.calls.length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function envelope(): EventEnvelope {
  return RequestContext.run(
    { tenantId: 'tenant-1', correlationId: 'corr-1', sourceService: undefined as never, startedAt: Date.now() },
    () =>
      makeEnvelope(EventTopic.ExpenseApproved, {
        reportId: 'r1',
        status: 'approved',
        approvedBy: 'u1',
        amountMinor: 1000,
        recipientUserId: 'sub-1',
      }),
  );
}

describe('KafkaBus DLQ', () => {
  beforeEach(() => {
    producerSend.mockClear();
    commitOffsets.mockClear();
    consumerSubscribe.mockClear();
    consumerRun.mockClear();
    consumerFactory.mockClear();
    capturedEachMessage = undefined;
  });

  it('uses one consumer for all topics in a worker group', async () => {
    const bus = new KafkaBus({ brokers: ['localhost:9092'] });

    bus.subscribe(EventTopic.ExpenseApproved, () => undefined);
    bus.subscribe(EventTopic.ExpenseRejected, () => undefined);
    await bus.start();

    expect(consumerFactory).toHaveBeenCalledTimes(1);
    expect(consumerSubscribe).toHaveBeenCalledTimes(2);
    expect(consumerSubscribe).toHaveBeenCalledWith({
      topic: EventTopic.ExpenseApproved,
      fromBeginning: false,
    });
    expect(consumerSubscribe).toHaveBeenCalledWith({
      topic: EventTopic.ExpenseRejected,
      fromBeginning: false,
    });
    expect(consumerRun).toHaveBeenCalledTimes(1);

    await bus.stop();
  });

  it('publishes the failed envelope to <topic>.dlq before committing the offset', async () => {
    const bus = new KafkaBus({
      brokers: ['localhost:9092'],
      retryHandlerMaxNo: 2,
      retryDelayMs: 1,
    });

    bus.subscribe(EventTopic.ExpenseApproved, () => {
      throw new Error('handler always fails');
    });
    await bus.start();
    expect(capturedEachMessage).toBeDefined();

    const env = envelope();
    await capturedEachMessage!({
      topic: EventTopic.ExpenseApproved,
      partition: 0,
      message: { offset: '7', value: Buffer.from(JSON.stringify(env)) },
    });
    await waitForCommit();

    // The DLQ send must have happened.
    const dlqTopic = `${EventTopic.ExpenseApproved}${DLQ_SUFFIX}`;
    const dlqCall = producerSend.mock.calls.find(([c]) => c.topic === dlqTopic);
    expect(dlqCall).toBeDefined();
    const record = JSON.parse(dlqCall![0].messages[0].value);
    expect(record.originalTopic).toBe(EventTopic.ExpenseApproved);
    expect(record.offset).toBe('7');
    expect(record.attempts).toBe(2);
    expect(record.error).toBe('handler always fails');
    expect(record.envelope.payload.reportId).toBe('r1');

    // And the offset must be committed AFTER (so the message is recoverable, not lost).
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: EventTopic.ExpenseApproved, partition: 0, offset: '8' },
    ]);
    const dlqInvocationOrder = dlqCall![0] && producerSend.mock.invocationCallOrder[
      producerSend.mock.calls.findIndex(([c]) => c.topic === dlqTopic)
    ];
    const commitOrder = commitOffsets.mock.invocationCallOrder[0];
    expect(dlqInvocationOrder).toBeLessThan(commitOrder);

    await bus.stop();
  });

  it('does not DLQ when the handler succeeds; commits normally', async () => {
    const bus = new KafkaBus({ brokers: ['localhost:9092'], retryHandlerMaxNo: 2, retryDelayMs: 1 });
    const handled: string[] = [];
    bus.subscribe(EventTopic.ExpenseApproved, (env: EventEnvelope) => {
      handled.push(env.id);
    });
    await bus.start();

    const env = envelope();
    await capturedEachMessage!({
      topic: EventTopic.ExpenseApproved,
      partition: 0,
      message: { offset: '3', value: Buffer.from(JSON.stringify(env)) },
    });
    await waitForCommit();

    expect(handled).toHaveLength(1);
    const dlqTopic = `${EventTopic.ExpenseApproved}${DLQ_SUFFIX}`;
    expect(producerSend.mock.calls.find(([c]) => c.topic === dlqTopic)).toBeUndefined();
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: EventTopic.ExpenseApproved, partition: 0, offset: '4' },
    ]);

    await bus.stop();
  });
});
