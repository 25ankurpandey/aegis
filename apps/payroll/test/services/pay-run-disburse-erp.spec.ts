/**
 * W2-07 — pay-run disbursement must NOT push the GL journal to the ERP inline. The synchronous
 * `ConnectorRegistry.get(...).pushTransaction(...)` in disburse() is gone; it now stages a
 * `ConnectorPushRequested` event in the same transaction (transactional outbox) for the ERP-sync
 * consumer to push off the request path. Proves the inline push is gone and the event is staged.
 */
import { EventTopic } from '@aegis/events';
import { PayRunStatus, ConnectorKind, ConnectorEntity } from '@aegis/shared-enums';

const stageOutboxEvent = jest.fn();
jest.mock('@aegis/events', () => {
  const actual = jest.requireActual('@aegis/events');
  return {
    ...actual,
    stageOutboxEvent: (...args: unknown[]) => stageOutboxEvent(...args),
    makeEnvelope: (topic: unknown, payload: unknown) => ({ topic, payload, tenantId: 't1' }),
  };
});

const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
jest.mock('@aegis/db', () => ({ withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])) }));

jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn() } }));
// W5-13 — disburse now appends to the shared business timeline; stub it so this spec needs no DB.
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: jest.fn() } }));

// Spy on the registry so we can assert the connector is NEVER called from disburse().
const pushTransaction = jest.fn();
jest.mock('@aegis/connectors', () => ({
  ConnectorRegistry: { get: () => ({ pushTransaction }) },
}));

import { RequestContext } from '@aegis/service-core';
import { PayRunService } from '../../src/services/pay-run.service';

const RUN_ID = 'run-1';
const approvedRun = {
  id: RUN_ID,
  tenant_id: 't1',
  pay_calendar_id: null,
  period_start: '2026-01-01',
  period_end: '2026-01-15',
  pay_date: '2026-01-20',
  type: 'regular',
  status: PayRunStatus.Approved,
  created_by: 'maker-1',
  approved_by: 'checker-1',
  approved_at: new Date(),
  locked_snapshot: null,
};

function makeRepo() {
  return {
    findPayRunById: jest.fn().mockResolvedValue(approvedRun),
    listPayslipsByRun: jest.fn().mockResolvedValue([
      { id: 'slip-1', employee_id: 'e1', gross: 1000, total_tax: 0, total_deductions: 0, currency: 'USD' },
    ]),
    createPaymentBatch: jest.fn().mockResolvedValue({ id: 'batch-1' }),
    findPaymentByIdempotencyKey: jest.fn().mockResolvedValue(null),
    createPayment: jest.fn().mockResolvedValue(undefined),
    appendLedgerEntry: jest.fn().mockResolvedValue(undefined),
    updatePayRun: jest.fn().mockResolvedValue({ ...approvedRun, status: PayRunStatus.Paid }),
    // W5-07: disburse flips Approved → Paid via the version-checked update.
    updatePayRunVersioned: jest.fn().mockResolvedValue({ ...approvedRun, status: PayRunStatus.Paid }),
    glSummaryForRun: jest.fn().mockResolvedValue([{ account: 'wage_expense', debit: 1000, credit: 0 }]),
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'disburser-1', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

describe('W2-07 pay-run.disburse — ERP GL push moved off the request path', () => {
  beforeEach(() => {
    stageOutboxEvent.mockClear();
    pushTransaction.mockClear();
  });

  it('does NOT call the connector inline on disburse', async () => {
    const repo = makeRepo();
    const service = new PayRunService(repo as never, {} as never, {} as never);
    await run(() => service.disburse(RUN_ID, 'idem-1'));
    expect(pushTransaction).not.toHaveBeenCalled();
  });

  it('stages a ConnectorPushRequested event for the payroll journal', async () => {
    const repo = makeRepo();
    const service = new PayRunService(repo as never, {} as never, {} as never);
    await run(() => service.disburse(RUN_ID, 'idem-1'));

    const pushEvents = stageOutboxEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.topic === EventTopic.ConnectorPushRequested);
    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0].payload).toMatchObject({
      connectorKind: ConnectorKind.LedgerOne,
      entity: ConnectorEntity.PayrollJournal,
      recordType: 'pay_run',
      recordId: RUN_ID,
    });
    // idempotencyKey is run-id-scoped so a redelivery maps to the same ERP record.
    expect(pushEvents[0].payload.idempotencyKey).toMatch(new RegExp(`^${RUN_ID}:`));
  });
});
