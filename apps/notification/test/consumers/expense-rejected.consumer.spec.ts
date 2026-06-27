import { RequestContext } from '@aegis/service-core';
import { NotificationCode } from '@aegis/shared-enums';
import { InProcessBus, setBus, makeEnvelope, EventTopic } from '@aegis/events';
import { container } from '../../src/ioc/container';
import { NotificationService } from '../../src/services/notification.service';
import { registerConsumers } from '../../src/consumers/notification.consumer';

/**
 * ExpenseRejected regression (same produced-with-no-consumer class as BUG-0001/BUG-0002). apps/expense
 * PRODUCES `ExpenseRejected` (two publish sites) but, before this fix, NOTHING subscribed — so the
 * submitter's rejection notification was silently dropped even though a `NotificationCode.ExpenseRejected`
 * already existed.
 *
 * This proves the new consumer (a) IS subscribed, (b) maps the payload to the typed `ExpenseRejected`
 * message (carrying the optional reason), (c) addresses the recipient from the payload hint, and (d)
 * reads tenant from the ENVELOPE — dispatching through the same `resolveAndDispatch` pipeline the other
 * typed codes use.
 */
describe('ExpenseRejected — notification consumer handles ExpenseRejected', () => {
  let dispatched: Array<{ message: unknown; spec: unknown; ctxTenant: string }>;
  let bus: InProcessBus;

  beforeEach(() => {
    process.env.KAFKA_RETRY_MAX = '1';
    process.env.KAFKA_RETRY_DELAY_MS = '1';
    dispatched = [];

    const fakeService = {
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

  it('dispatches an ExpenseRejected as the typed ExpenseRejected message (was silently dropped before)', async () => {
    const env = RequestContext.run(
      { tenantId: 'tenant-42', correlationId: 'c-1', sourceService: undefined as never, startedAt: Date.now() },
      () =>
        makeEnvelope(EventTopic.ExpenseRejected, {
          recipientUserId: 'submitter-1',
          recipientEmail: 'submitter@example.com',
          reportId: 'rep-9',
          status: 'rejected',
          rejectedBy: 'manager-7',
          reason: 'missing receipts',
        }),
    );

    await bus.publish(env);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ctxTenant).toBe('tenant-42'); // tenant came from the envelope
    expect(dispatched[0].spec).toEqual({
      kind: 'user',
      userId: 'submitter-1',
      email: 'submitter@example.com',
    });
    expect(dispatched[0].message).toEqual({
      code: NotificationCode.ExpenseRejected,
      reportId: 'rep-9',
      rejectedBy: 'manager-7',
      reason: 'missing receipts',
    });
  });

  it('tolerates a missing reason (carries it through as undefined)', async () => {
    const env = RequestContext.run(
      { tenantId: 'tenant-42', correlationId: 'c-2', sourceService: undefined as never, startedAt: Date.now() },
      () =>
        makeEnvelope(EventTopic.ExpenseRejected, {
          recipientUserId: 'submitter-2',
          reportId: 'rep-10',
          status: 'rejected',
          rejectedBy: 'manager-7',
        }),
    );

    await bus.publish(env);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].message).toEqual({
      code: NotificationCode.ExpenseRejected,
      reportId: 'rep-10',
      rejectedBy: 'manager-7',
      reason: undefined,
    });
  });

  it('does NOT dispatch when the envelope tenant is empty (fail-closed)', async () => {
    const env = makeEnvelope(EventTopic.ExpenseRejected, {
      recipientUserId: 'submitter-3',
      reportId: 'rep-11',
      status: 'rejected',
      rejectedBy: 'manager-7',
    });
    expect(env.tenantId).toBe('');
    await bus.publish(env);
    expect(dispatched).toHaveLength(0);
  });
});
