import { RequestContext } from '@aegis/service-core';
import { NotificationCode } from '@aegis/shared-enums';
import { InProcessBus, setBus, makeEnvelope, EventTopic } from '@aegis/events';
import { container } from '../../src/ioc/container';
import { NotificationService } from '../../src/services/notification.service';
import { registerConsumers } from '../../src/consumers/notification.consumer';

/**
 * BUG-0002 regression. A workflow `notify` rule action publishes `NotificationRequested` with a
 * free-form `template` + `context` and a recipient hint. Before the fix, the notification service
 * subscribed only to ExpenseApproved/InvoiceApproved/ApprovalRequested/PayRunApproved, so the event
 * had NO consumer and rule-authored notifications were silently dropped.
 *
 * This proves the new consumer (a) IS subscribed, (b) maps the payload to the generic `RuleNotice`
 * message, (c) addresses the recipient from the payload hint, and (d) reads tenant from the ENVELOPE
 * — dispatching through the same `resolveAndDispatch` pipeline the typed codes use.
 */
describe('BUG-0002 — notification consumer handles NotificationRequested', () => {
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

  it('dispatches a rule-authored NotificationRequested as a RuleNotice (was silently dropped before)', async () => {
    const env = RequestContext.run(
      { tenantId: 'tenant-42', correlationId: 'c-1', sourceService: undefined as never, startedAt: Date.now() },
      () =>
        makeEnvelope(EventTopic.NotificationRequested, {
          recipientUserId: 'owner-1',
          recipientEmail: 'owner@example.com',
          template: 'rule.notice',
          context: { recordType: 'invoice', recordId: 'inv-9', ruleId: 'rule-7' },
        }),
    );

    await bus.publish(env);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ctxTenant).toBe('tenant-42'); // tenant came from the envelope
    expect(dispatched[0].spec).toEqual({ kind: 'user', userId: 'owner-1', email: 'owner@example.com' });
    expect(dispatched[0].message).toEqual({
      code: NotificationCode.RuleNotice,
      template: 'rule.notice',
      context: { recordType: 'invoice', recordId: 'inv-9', ruleId: 'rule-7' },
    });
  });

  it('tolerates a missing context (defaults to an empty map)', async () => {
    const env = RequestContext.run(
      { tenantId: 'tenant-42', correlationId: 'c-2', sourceService: undefined as never, startedAt: Date.now() },
      () =>
        makeEnvelope(EventTopic.NotificationRequested, {
          recipientUserId: 'owner-2',
          template: 'rule.notice',
          context: undefined as unknown as Record<string, unknown>,
        }),
    );

    await bus.publish(env);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].message).toEqual({
      code: NotificationCode.RuleNotice,
      template: 'rule.notice',
      context: {},
    });
  });

  it('does NOT dispatch when the envelope tenant is empty (fail-closed)', async () => {
    const env = makeEnvelope(EventTopic.NotificationRequested, {
      recipientUserId: 'owner-3',
      template: 'rule.notice',
      context: {},
    });
    expect(env.tenantId).toBe('');
    await bus.publish(env);
    expect(dispatched).toHaveLength(0);
  });
});
