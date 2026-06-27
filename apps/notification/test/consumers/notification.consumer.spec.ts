import { RequestContext } from '@aegis/service-core';
import { NotificationCode } from '@aegis/shared-enums';
import { InProcessBus, setBus, makeEnvelope, EventTopic } from '@aegis/events';
import { container } from '../../src/ioc/container';
import { NotificationService } from '../../src/services/notification.service';
import { registerConsumers } from '../../src/consumers/notification.consumer';

/**
 * Proves the contract fix: the consumer reads tenant from the ENVELOPE (the bus rebuilds it into the
 * RequestContext) — NOT from a payload.tenantId that never existed — so notifications are actually
 * delivered, and it addresses the recipient from the typed payload hint.
 */
describe('notification consumer reads tenant from the envelope', () => {
  let dispatched: Array<{ message: unknown; spec: unknown; ctxTenant: string }>;
  let bus: InProcessBus;

  beforeEach(() => {
    process.env.KAFKA_RETRY_MAX = '1';
    process.env.KAFKA_RETRY_DELAY_MS = '1';
    dispatched = [];

    const fakeService = {
      // The consumer now routes through the W3-09 resolver entrypoint (message + recipient SPEC).
      resolveAndDispatch: jest.fn(async (message: unknown, spec: unknown) => {
        dispatched.push({ message, spec, ctxTenant: RequestContext.tenantId() });
      }),
    } as unknown as NotificationService;
    jest.spyOn(container, 'get').mockReturnValue(fakeService);

    bus = new InProcessBus();
    setBus(bus);
    registerConsumers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setBus(new InProcessBus());
  });

  it('delivers ExpenseApproved with tenant from envelope + recipient from payload hint', async () => {
    const env = RequestContext.run(
      { tenantId: 'tenant-77', correlationId: 'c', sourceService: undefined as never, startedAt: Date.now() },
      () =>
        makeEnvelope(EventTopic.ExpenseApproved, {
          reportId: 'r1',
          status: 'approved',
          approvedBy: 'mgr-1',
          amountMinor: 5000,
          recipientUserId: 'sub-1',
          recipientEmail: 'sub@example.com',
        }),
    );

    await bus.publish(env);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ctxTenant).toBe('tenant-77'); // tenant came from the envelope
    expect(dispatched[0].spec).toEqual({ kind: 'user', userId: 'sub-1', email: 'sub@example.com' });
    expect(dispatched[0].message).toMatchObject({
      code: NotificationCode.ExpenseApproved,
      reportId: 'r1',
      approvedBy: 'mgr-1',
      amountMinor: 5000,
    });
  });

  it('does NOT dispatch when the envelope tenant is empty (fail-closed)', async () => {
    // An envelope with no tenant (producer had no context) must not deliver under a mismatched scope.
    const env = makeEnvelope(EventTopic.PayRunApproved, {
      payRunId: 'p1',
      approvedBy: 'a',
      recipientUserId: 'm',
    });
    // makeEnvelope outside a context stamps tenantId ''. The bus rebuilds ctx tenant '' and the guard
    // throws (mismatch with required scope), so the handler retries-then-DLQs and never dispatches.
    expect(env.tenantId).toBe('');
    await bus.publish(env);
    expect(dispatched).toHaveLength(0);
  });
});
