/**
 * W5-12 — RECONCILE DUAL APPROVAL-COMPLETED SOURCES.
 *
 * Now that approvals flow through `@aegis/approvals` (which stages `ApprovalCompleted` once per chain)
 * AND the owning domain services ALSO emit `*Approved` topics (notification-bound), the workflow rules
 * consumer must pick ONE canonical trigger for `RuleEvent.ApprovalCompleted` so a rule fires exactly
 * once per approval — never twice (double-mapped) and never zero times (missed). The chosen canonical
 * trigger is the engine's `EventTopic.ApprovalCompleted`. This spec proves:
 *   1. the rule engine subscribes to `ApprovalCompleted` (canonical) — and NOT to the `*Approved` topics;
 *   2. a single completed approval drives `evaluateRules(ApprovalCompleted, …)` exactly once;
 *   3. the canonical payload's `recordType`/`recordId` are normalized into the engine facts.
 */
import { EventTopic, type EventEnvelope, type EventHandler } from '@aegis/events';
import { RuleEvent } from '@aegis/shared-enums';

// A fake bus that records subscriptions so we can introspect the wiring and drive handlers.
const subscriptions = new Map<EventTopic, EventHandler>();
const fakeBus = {
  subscribe: jest.fn((topic: EventTopic, handler: EventHandler) => {
    subscriptions.set(topic, handler);
  }),
  publish: jest.fn(),
};

jest.mock('@aegis/events', () => {
  const actual = jest.requireActual('@aegis/events');
  return { ...actual, getBus: () => fakeBus };
});

// The connector-sync consumer registers its own subscription on import; stub it so this spec stays
// focused on the rule-trigger wiring (it has its own dedicated spec).
jest.mock('../../src/consumers/connector-sync.consumer', () => ({ registerConnectorSyncConsumer: jest.fn() }));

// Stub the DI container so `container.get(RuleService)` yields a spyable evaluateRules. The real
// `provideSingleton` decorator (applied at module load by the rule repository/service) is preserved as
// a no-op so importing them never touches a real container binding.
const evaluateRules = jest.fn().mockResolvedValue([]);
jest.mock('../../src/ioc/container', () => ({
  container: { get: () => ({ evaluateRules: (...a: unknown[]) => evaluateRules(...a) }) },
  provideSingleton: () => () => undefined,
}));

// The repository reaches for the DB context; stub the seam so this consumer-wiring spec never needs a
// real Postgres connection.
jest.mock('@aegis/db', () => ({
  withTenantTransaction: (fn: (t: unknown) => Promise<unknown>) => fn({}),
}));
jest.mock('../../src/models/database-context', () => ({ getWorkflowContext: () => ({}) }));

import { registerConsumers } from '../../src/consumers/index';

function completedEnvelope(recordType: string, recordId: string): EventEnvelope {
  return {
    id: 'evt-1',
    topic: EventTopic.ApprovalCompleted,
    tenantId: 't1',
    correlationId: 'corr-1',
    occurredAt: new Date().toISOString(),
    payload: {
      approvalId: 'appr-1',
      subjectType: recordType,
      subjectId: recordId,
      outcome: 'approved',
      recordType,
      recordId,
      decidedBy: 'checker-1',
    },
  } as EventEnvelope;
}

beforeEach(() => {
  subscriptions.clear();
  fakeBus.subscribe.mockClear();
  evaluateRules.mockClear();
  registerConsumers();
});

describe('W5-12 single canonical approval trigger', () => {
  it('subscribes the rule engine to the canonical ApprovalCompleted topic', () => {
    expect(subscriptions.has(EventTopic.ApprovalCompleted)).toBe(true);
  });

  it('does NOT map the per-domain *Approved topics to the rule engine (avoids double-fire)', () => {
    expect(subscriptions.has(EventTopic.PayRunApproved)).toBe(false);
    expect(subscriptions.has(EventTopic.ExpenseApproved)).toBe(false);
    expect(subscriptions.has(EventTopic.InvoiceApproved)).toBe(false);
  });

  it('fires evaluateRules exactly once per completed approval, as RuleEvent.ApprovalCompleted', async () => {
    const handler = subscriptions.get(EventTopic.ApprovalCompleted)!;
    await handler(completedEnvelope('pay_run', 'run-1'));

    expect(evaluateRules).toHaveBeenCalledTimes(1);
    expect(evaluateRules).toHaveBeenCalledWith(RuleEvent.ApprovalCompleted, expect.anything());
  });

  it('normalizes the canonical recordType/recordId into uniform engine facts', async () => {
    const handler = subscriptions.get(EventTopic.ApprovalCompleted)!;
    await handler(completedEnvelope('expense_report', 'rep-9'));

    const [, facts] = evaluateRules.mock.calls[0];
    expect(facts).toMatchObject({ record_type: 'expense_report', id: 'rep-9', outcome: 'approved' });
  });
});
