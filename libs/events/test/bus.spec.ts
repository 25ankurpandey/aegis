import { RequestContext } from '@aegis/service-core';
import { InProcessBus, setDeadLetterSink, type DeadLetterSink } from '../src/bus';
import { makeEnvelope } from '../src/topics';
import { EventTopic } from '../src/topics';

/** Run a fn inside a tenant-scoped RequestContext so makeEnvelope stamps the tenant/correlation. */
function inTenant<T>(tenantId: string, fn: () => T): T {
  return RequestContext.run(
    { tenantId, correlationId: 'corr-1', sourceService: undefined as never, startedAt: Date.now() },
    fn,
  );
}

describe('InProcessBus', () => {
  beforeEach(() => {
    // Tighten retry timing so the retry-then-DLQ test runs fast.
    process.env.KAFKA_RETRY_MAX = '3';
    process.env.KAFKA_RETRY_DELAY_MS = '1';
  });

  it('rebuilds the producer RequestContext (tenant + correlation) for each handler', async () => {
    const bus = new InProcessBus();
    const seen: Array<{ tenant: string; corr: string }> = [];
    bus.subscribe(EventTopic.ExpenseApproved, () => {
      seen.push({ tenant: RequestContext.tenantId(), corr: RequestContext.correlationId() });
    });

    const env = inTenant('tenant-A', () =>
      makeEnvelope(EventTopic.ExpenseApproved, {
        reportId: 'r1',
        status: 'approved',
        approvedBy: 'u1',
        amountMinor: 1000,
        recipientUserId: 'u2',
      }),
    );
    await bus.publish(env);

    expect(seen).toEqual([{ tenant: 'tenant-A', corr: 'corr-1' }]);
  });

  it('retries a failing handler then DLQs on exhaustion (no silent swallow)', async () => {
    const bus = new InProcessBus();
    let calls = 0;
    bus.subscribe(EventTopic.ExpenseApproved, () => {
      calls += 1;
      throw new Error('boom');
    });

    const dlq: Array<{ topic: EventTopic; attempts: number; error: string }> = [];
    const sink: DeadLetterSink = (_env, meta) =>
      void dlq.push({ topic: meta.topic, attempts: meta.attempts, error: meta.error.message });
    setDeadLetterSink(sink);

    const env = inTenant('tenant-A', () =>
      makeEnvelope(EventTopic.ExpenseApproved, {
        reportId: 'r1',
        status: 'approved',
        approvedBy: 'u1',
        amountMinor: 1000,
        recipientUserId: 'u2',
      }),
    );
    await bus.publish(env);

    expect(calls).toBe(3); // retryMax attempts
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toEqual({ topic: EventTopic.ExpenseApproved, attempts: 3, error: 'boom' });

    // Restore default sink so other tests are unaffected.
    setDeadLetterSink((env2, meta) => {
      void env2;
      void meta;
    });
  });

  it('does not DLQ when a handler eventually succeeds', async () => {
    const bus = new InProcessBus();
    let calls = 0;
    bus.subscribe(EventTopic.PayRunApproved, () => {
      calls += 1;
      if (calls < 2) throw new Error('transient');
    });
    let dlqCount = 0;
    setDeadLetterSink(() => void (dlqCount += 1));

    const env = inTenant('t', () =>
      makeEnvelope(EventTopic.PayRunApproved, { payRunId: 'p1', approvedBy: 'a', recipientUserId: 'm' }),
    );
    await bus.publish(env);

    expect(calls).toBe(2);
    expect(dlqCount).toBe(0);
    setDeadLetterSink(() => undefined);
  });
});
