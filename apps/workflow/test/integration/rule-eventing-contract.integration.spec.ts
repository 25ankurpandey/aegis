/**
 * INTEGRATION (Track B — eventing contract, full pipeline). Proves the workflow side of the
 * cross-service event contract across a REAL bus + REAL relay, complementing the unit-level
 * approval-trigger spec (which drives a fake bus):
 *
 *     staged domain envelope  →  OutboxRelay.drainOnce (real)
 *                             →  InProcessBus (real)  →  workflow consumers (real registerConsumers)
 *                             →  RuleService.evaluateRules (spied)
 *
 * Only the rule ENGINE (`evaluateRules`) and the DB are stubbed; the topic→RuleEvent map, the real
 * `toFacts` normalisation, and the real bus subscriptions are exercised as shipped. This locks in the
 * "workflow maps real domain topics → rule events once" bullet end-to-end:
 *   1. a domain `ExpenseSubmitted`/`InvoiceReceived` published through the relay fires
 *      `RuleEvent.RecordSubmitted` exactly once, with the engine facts normalised to a uniform
 *      `record_type`/`id`;
 *   2. the canonical `ApprovalCompleted` fires `RuleEvent.ApprovalCompleted` exactly once, carrying
 *      the polymorphic key + outcome — for ANY record type;
 *   3. the per-domain `*Approved` topics (ExpenseApproved/InvoiceApproved/PayRunApproved) are NOT
 *      mapped to a RuleEvent, so a single approval never DOUBLE-fires a rule (W5-12).
 */
import { RuleEvent } from '@aegis/shared-enums';

// Stub the DB seam the relay opens its transaction on, backed by an in-memory outbox table.
import type { Transaction } from 'sequelize';
interface OutboxRecord {
  id: string;
  tenant_id: string;
  topic: string;
  payload: unknown;
  envelope: Record<string, unknown>;
  status: 'pending' | 'published' | 'failed';
  attempts: number;
}
const outboxTable: OutboxRecord[] = [];

jest.mock('@aegis/db', () => ({
  withTenantTransaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> => fn({} as Transaction),
  getSequelize: () => ({
    transaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> => fn({} as Transaction),
    query: async (sql: string, opts?: { bind?: unknown[] }) => {
      if (/INSERT INTO\s+"event_outbox"/i.test(sql)) {
        const bind = opts?.bind ?? [];
        outboxTable.push({
          id: bind[0] as string,
          tenant_id: bind[1] as string,
          topic: bind[2] as string,
          payload: JSON.parse((bind[3] as string) ?? '{}'),
          envelope: JSON.parse((bind[4] as string) ?? '{}'),
          status: 'pending',
          attempts: 0,
        });
        return [];
      }
      if (/set_config/i.test(sql)) return [];
      if (/SELECT[\s\S]+FROM\s+"event_outbox"/i.test(sql)) {
        return outboxTable.filter((r) => r.status === 'pending');
      }
      if (/UPDATE\s+"event_outbox"[\s\S]+status\s*=\s*'published'/i.test(sql)) {
        const row = outboxTable.find((r) => r.id === opts?.bind?.[0]);
        if (row) row.status = 'published';
        return [];
      }
      if (/UPDATE\s+"event_outbox"/i.test(sql)) {
        const [id, attempts, status] = opts?.bind ?? [];
        const row = outboxTable.find((r) => r.id === id);
        if (row) {
          row.attempts = attempts as number;
          row.status = status as OutboxRecord['status'];
        }
        return [];
      }
      return [];
    },
  }),
}));

// The connector-sync consumer registers on import and reaches for the DB context on receipt; we never
// publish ConnectorPushRequested here, so stub the model seam it touches at module load.
jest.mock('../../src/models/database-context', () => ({ getWorkflowContext: () => ({}) }));

// Stub only the rule engine: container.get(RuleService) → a spyable evaluateRules. The real
// provideSingleton decorator on the repository/service is preserved as a no-op so importing the
// consumers never binds a real container token.
const evaluateRules = jest.fn().mockResolvedValue([]);
jest.mock('../../src/ioc/container', () => ({
  container: { get: () => ({ evaluateRules: (...a: unknown[]) => evaluateRules(...a) }) },
  provideSingleton: () => () => undefined,
}));

import { RequestContext } from '@aegis/service-core';
import {
  InProcessBus,
  setBus,
  OutboxRelay,
  makeEnvelope,
  stageOutboxEvent,
  EventTopic,
  type EventEnvelope,
  type PayloadOf,
} from '@aegis/events';
import { registerConsumers } from '../../src/consumers/index';

const TENANT = 'tenant-wf-9';

/** Stage a typed domain envelope into the in-memory outbox under a producer context (real path). */
async function stage<T extends EventTopic>(topic: T, payload: PayloadOf<T>): Promise<void> {
  await RequestContext.run(
    { tenantId: TENANT, userId: 'producer', correlationId: 'c-wf', startedAt: Date.now() } as never,
    async () => stageOutboxEvent(makeEnvelope(topic, payload), {} as Transaction),
  );
}

describe('eventing contract — domain topics → RuleEvent via the real relay + bus + workflow consumers', () => {
  let bus: InProcessBus;
  let relay: OutboxRelay;

  beforeEach(() => {
    process.env.KAFKA_RETRY_MAX = '1';
    process.env.KAFKA_RETRY_DELAY_MS = '1';
    outboxTable.length = 0;
    evaluateRules.mockClear();

    bus = new InProcessBus();
    setBus(bus);
    registerConsumers(); // real subscriptions: TOPIC_TO_RULE_EVENT + connector-sync
    relay = new OutboxRelay({ bus });
  });

  afterEach(() => setBus(new InProcessBus()));

  it('ExpenseSubmitted → RuleEvent.RecordSubmitted ONCE, facts normalised to record_type=expense_report', async () => {
    await stage(EventTopic.ExpenseSubmitted, {
      reportId: 'rep-1',
      status: 'approvals',
      submitterId: 'sub-1',
      totalAmount: 4200,
      event: 'submitted',
    });

    const published = await relay.drainOnce();
    expect(published).toBe(1);

    expect(evaluateRules).toHaveBeenCalledTimes(1);
    const [ruleEvent, facts] = evaluateRules.mock.calls[0];
    expect(ruleEvent).toBe(RuleEvent.RecordSubmitted);
    expect(facts).toMatchObject({ record_type: 'expense_report', id: 'rep-1', status: 'approvals' });
  });

  it('InvoiceReceived → RuleEvent.RecordSubmitted ONCE, facts normalised to record_type=invoice', async () => {
    await stage(EventTopic.InvoiceReceived, { invoiceId: 'inv-7', status: 'received', submitterId: 's' });

    await relay.drainOnce();

    expect(evaluateRules).toHaveBeenCalledTimes(1);
    const [ruleEvent, facts] = evaluateRules.mock.calls[0];
    expect(ruleEvent).toBe(RuleEvent.RecordSubmitted);
    expect(facts).toMatchObject({ record_type: 'invoice', id: 'inv-7' });
  });

  it('ApprovalCompleted → RuleEvent.ApprovalCompleted ONCE with the canonical key + outcome (any record type)', async () => {
    await stage(EventTopic.ApprovalCompleted, {
      approvalId: 'appr-1',
      subjectType: 'pay_run',
      subjectId: 'run-3',
      outcome: 'approved',
      recordType: 'pay_run',
      recordId: 'run-3',
      decidedBy: 'checker-1',
    });

    await relay.drainOnce();

    expect(evaluateRules).toHaveBeenCalledTimes(1);
    const [ruleEvent, facts] = evaluateRules.mock.calls[0];
    expect(ruleEvent).toBe(RuleEvent.ApprovalCompleted);
    expect(facts).toMatchObject({ record_type: 'pay_run', id: 'run-3', outcome: 'approved' });
  });

  it('the per-domain *Approved topics do NOT map to a RuleEvent — a single approval never double-fires (W5-12)', async () => {
    // The owning service emits BOTH ApprovalCompleted (engine) AND ExpenseApproved (notification-bound)
    // in the same flow. Only the engine topic is a rule trigger, so the rule fires exactly once.
    await stage(EventTopic.ApprovalCompleted, {
      approvalId: 'a',
      subjectType: 'expense_report',
      subjectId: 'rep-9',
      outcome: 'approved',
      recordType: 'expense_report',
      recordId: 'rep-9',
      decidedBy: 'm',
    });
    await stage(EventTopic.ExpenseApproved, {
      reportId: 'rep-9',
      status: 'approved',
      approvedBy: 'm',
      amountMinor: 1000,
      recipientUserId: 'sub-9',
    });

    await relay.drainOnce();

    // Exactly one rule evaluation — the ExpenseApproved publish reached the bus but no consumer maps it.
    expect(evaluateRules).toHaveBeenCalledTimes(1);
    expect(evaluateRules.mock.calls[0][0]).toBe(RuleEvent.ApprovalCompleted);
  });

  it('a workflow-produced topic (RecordUpdated) is NOT consumed by the rules engine — no produce/consume loop', async () => {
    await stage(EventTopic.RecordUpdated, { recordType: 'expense_report', recordId: 'rep-x', foo: 1 });

    await relay.drainOnce();

    expect(evaluateRules).not.toHaveBeenCalled();
  });

  it('the rebuilt consumer context carries the envelope tenant + correlation id across the async hop', async () => {
    let seenTenant: string | undefined;
    let seenCorrelation: string | undefined;
    evaluateRules.mockImplementationOnce(async () => {
      seenTenant = RequestContext.tenantId();
      seenCorrelation = RequestContext.correlationId();
      return [];
    });

    await stage(EventTopic.ExpenseSubmitted, {
      reportId: 'rep-ctx',
      status: 'approvals',
      submitterId: 'sub',
    });
    const env = outboxTable[0].envelope as unknown as EventEnvelope;

    await relay.drainOnce();

    expect(seenTenant).toBe(TENANT);
    expect(seenCorrelation).toBe(env.correlationId);
  });
});
