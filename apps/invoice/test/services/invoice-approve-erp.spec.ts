/**
 * W2-07 — invoice approval must NOT push to the ERP inline. The synchronous
 * `ConnectorRegistry.get(...).pushTransaction(...)` in the request path is gone; the engine-backed
 * approve path now stages a `ConnectorPushRequested` event in the same transaction (transactional
 * outbox) on completion and the ERP-sync consumer performs the actual push off the request path.
 * This test proves the inline push is gone and the event is staged with idempotencyKey = invoice id,
 * driving the flow through the shared approval engine (a single-vote chain that completes approved).
 */
import { EventTopic } from '@aegis/events';
import { InvoiceStatus, ConnectorKind, ConnectorEntity, ApprovalRecordType } from '@aegis/shared-enums';

// ---- mock the infrastructure the service touches (no real DB / bus / audit) ----
const stageOutboxEvent = jest.fn();
jest.mock('@aegis/events', () => {
  const actual = jest.requireActual('@aegis/events');
  return {
    ...actual,
    stageOutboxEvent: (...args: unknown[]) => stageOutboxEvent(...args),
    // makeEnvelope is pure but reads RequestContext; stub it to echo topic+payload for assertions.
    makeEnvelope: (topic: unknown, payload: unknown) => ({ topic, payload, tenantId: 't1' }),
  };
});

const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
jest.mock('@aegis/db', () => ({ withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])) }));

const auditRecord = jest.fn();
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: (...a: unknown[]) => auditRecord(...a) } }));

// ActivityLogger.record is a no-op in unit tests (the shared business timeline is covered by
// libs/activity specs); without this it would reach for a real model/connection.
const activityRecord = jest.fn().mockResolvedValue(undefined);
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: (...a: unknown[]) => activityRecord(...a) } }));

// Spy on the registry so we can assert the connector is NEVER called from the request path.
const pushTransaction = jest.fn();
jest.mock('@aegis/connectors', () => ({
  ConnectorRegistry: { get: () => ({ pushTransaction }) },
}));

import { RequestContext } from '@aegis/service-core';
import type { ApprovalService } from '@aegis/approvals';
import { InvoiceService } from '../../src/services/invoice.service';

const INVOICE_ID = 'inv-1';
const row = {
  id: INVOICE_ID,
  tenant_id: 't1',
  vendor_id: null,
  vendor_name: 'Acme',
  invoice_number: 'INV-100',
  invoice_date: '2026-01-01',
  due_date: null,
  amount_minor: '12345',
  currency: 'USD',
  transaction_type: 'debit',
  status: InvoiceStatus.ForApproval,
  auto_approved: false,
  auto_approved_by: null,
  approval_policy_id: null,
  submitted_by: 'maker-1',
  created_by: 'maker-1',
  created_at: new Date(),
  updated_at: new Date(),
};

function makeRepo() {
  return {
    findById: jest.fn().mockResolvedValue(row),
    createApproval: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    recordActivity: jest.fn().mockResolvedValue(undefined),
  };
}

/** A stub approval engine whose `decide` completes the chain as approved on the first vote. */
function makeApprovals(): jest.Mocked<ApprovalService> {
  return {
    requestApproval: jest.fn(),
    decide: jest.fn().mockResolvedValue({
      recordType: ApprovalRecordType.Invoice,
      recordId: INVOICE_ID,
      completed: true,
      outcome: 'approved',
      chain: [
        {
          id: 'slot-1',
          tenant_id: 't1',
          record_type: ApprovalRecordType.Invoice,
          record_id: INVOICE_ID,
          level: 1,
          approver_type: 'user',
          approver_id: 'approver-1',
          status: 'approved',
          sequence: 1,
          is_active: true,
        },
      ],
    }),
    listPendingForApprover: jest.fn().mockResolvedValue([]),
    getStatus: jest.fn(),
    reassign: jest.fn(),
    useResolver: jest.fn(),
  } as unknown as jest.Mocked<ApprovalService>;
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'approver-1', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

describe('W2-07 invoice.approve — engine-backed, ERP push off the request path', () => {
  beforeEach(() => {
    stageOutboxEvent.mockClear();
    pushTransaction.mockClear();
    auditRecord.mockClear();
    activityRecord.mockClear();
  });

  it('does NOT call the connector inline on approve', async () => {
    const service = new InvoiceService(makeRepo() as never, makeApprovals());
    await run(() => service.approve(INVOICE_ID, {}));
    expect(pushTransaction).not.toHaveBeenCalled();
  });

  it('stages a ConnectorPushRequested event (idempotencyKey = invoice id) in the same tx', async () => {
    const service = new InvoiceService(makeRepo() as never, makeApprovals());
    await run(() => service.approve(INVOICE_ID, {}));

    const pushEvents = stageOutboxEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.topic === EventTopic.ConnectorPushRequested);
    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0].payload).toMatchObject({
      connectorKind: ConnectorKind.LedgerOne,
      entity: ConnectorEntity.Invoice,
      idempotencyKey: INVOICE_ID,
      recordType: 'invoice',
      recordId: INVOICE_ID,
    });
  });

  it('still records the approval audit entry', async () => {
    const service = new InvoiceService(makeRepo() as never, makeApprovals());
    await run(() => service.approve(INVOICE_ID, {}));
    expect(auditRecord).toHaveBeenCalled();
  });

  it('drives the decision through the shared engine keyed by (Invoice, id)', async () => {
    const approvals = makeApprovals();
    const service = new InvoiceService(makeRepo() as never, approvals);
    await run(() => service.approve(INVOICE_ID, { comment: 'ok' }));
    expect(approvals.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: ApprovalRecordType.Invoice,
        recordId: INVOICE_ID,
        approverId: 'approver-1',
        decision: 'approved',
        comment: 'ok',
      }),
    );
  });
});
