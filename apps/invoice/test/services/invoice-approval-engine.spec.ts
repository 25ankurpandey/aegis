/**
 * Engine-backed invoice approval flow — the invoice service now routes every approval through the
 * shared `@aegis/approvals` engine (the expense reference template). Covers submit → requestApproval
 * (empty + non-empty chain), decide advancing / not-yet-completing / rejecting the chain, the
 * not-ForApproval guard, and the pending-approvals inbox. Infrastructure (DB / events / audit /
 * activity / engine) is stubbed — no real Postgres / bus.
 */
import { EventTopic } from '@aegis/events';
import { InvoiceStatus, ApprovalRecordType } from '@aegis/shared-enums';
import type { ApprovalShape } from '@aegis/shared-types';

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

const auditRecord = jest.fn();
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: (...a: unknown[]) => auditRecord(...a) } }));

const activityRecord = jest.fn().mockResolvedValue(undefined);
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: (...a: unknown[]) => activityRecord(...a) } }));

const pushTransaction = jest.fn();
jest.mock('@aegis/connectors', () => ({ ConnectorRegistry: { get: () => ({ pushTransaction }) } }));

import { RequestContext } from '@aegis/service-core';
import type { ApprovalService } from '@aegis/approvals';
import { InvoiceService } from '../../src/services/invoice.service';

const INVOICE_ID = 'inv-1';

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
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
    lock_version: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function pendingSlot(approverId: string, level = 1): ApprovalShape.RecordApproverRow {
  return {
    id: `slot-${approverId}`,
    tenant_id: 't1',
    record_type: ApprovalRecordType.Invoice,
    record_id: INVOICE_ID,
    level,
    approver_type: 'user' as ApprovalShape.RecordApproverRow['approver_type'],
    approver_id: approverId,
    status: 'pending' as ApprovalShape.RecordApproverRow['status'],
    sequence: 1,
    is_active: true,
  };
}

function makeRepo(status: InvoiceStatus) {
  return {
    findById: jest.fn().mockResolvedValue(invoiceRow({ status })),
    createApproval: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    recordActivity: jest.fn().mockResolvedValue(undefined),
  };
}

function makeApprovals(): jest.Mocked<ApprovalService> {
  return {
    requestApproval: jest.fn(),
    decide: jest.fn(),
    listPendingForApprover: jest.fn().mockResolvedValue([]),
    getStatus: jest.fn(),
    reassign: jest.fn(),
    useResolver: jest.fn(),
  } as unknown as jest.Mocked<ApprovalService>;
}

function run<T>(fn: () => Promise<T>, userId = 'approver-1'): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId, correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

beforeEach(() => {
  stageOutboxEvent.mockClear();
  pushTransaction.mockClear();
  auditRecord.mockClear();
  activityRecord.mockClear();
});

describe('submit → requestApproval', () => {
  it('moves to ForApproval and routes into the engine keyed by (Invoice, id)', async () => {
    const repo = makeRepo(InvoiceStatus.PendingReview);
    const approvals = makeApprovals();
    approvals.requestApproval.mockResolvedValue({
      recordType: ApprovalRecordType.Invoice,
      recordId: INVOICE_ID,
      mode: 'sequential' as never,
      minApprovals: 1,
      chain: [pendingSlot('manager-1')], // non-empty ⇒ stays ForApproval
    });
    const service = new InvoiceService(repo as never, approvals);

    const dto = await run(() => service.submit(INVOICE_ID), 'maker-1');

    expect(repo.updateStatus).toHaveBeenCalledWith(
      INVOICE_ID,
      expect.objectContaining({ status: InvoiceStatus.ForApproval }),
      expect.anything(),
      // W5-07: the version-checked transition carries the version observed at the status gate.
      expect.anything(),
    );
    expect(approvals.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: ApprovalRecordType.Invoice,
        recordId: INVOICE_ID,
        // BUG-0007: the BIGINT minor-unit amount is now passed straight through as the DB-native
        // string (no lossy Number() coercion), so the engine can route large amounts correctly.
        amountMinor: '12345',
        currency: 'USD',
        requestedBy: 'maker-1',
      }),
    );
    // Mirrored onto the shared timeline too.
    expect(activityRecord).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: ApprovalRecordType.Invoice }),
      expect.anything(),
    );
    expect(dto.status).toBe(InvoiceStatus.ForApproval);
  });

  it('auto-advances to Approved when the engine resolves an EMPTY chain', async () => {
    const repo = makeRepo(InvoiceStatus.PendingReview);
    const approvals = makeApprovals();
    approvals.requestApproval.mockResolvedValue({
      recordType: ApprovalRecordType.Invoice,
      recordId: INVOICE_ID,
      mode: 'sequential' as never,
      minApprovals: 1,
      chain: [],
    });
    // submit pre-flight reads PendingReview; applyCompletion then re-reads (still ForApproval).
    repo.findById
      .mockResolvedValueOnce(invoiceRow({ status: InvoiceStatus.PendingReview }))
      .mockResolvedValue(invoiceRow({ status: InvoiceStatus.ForApproval }));
    const service = new InvoiceService(repo as never, approvals);

    const dto = await run(() => service.submit(INVOICE_ID), 'maker-1');

    expect(repo.updateStatus).toHaveBeenCalledWith(
      INVOICE_ID,
      { status: InvoiceStatus.Approved },
      expect.anything(),
      expect.anything(), // W5-07 version-checked transition
    );
    const pushEvents = stageOutboxEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.topic === EventTopic.ConnectorPushRequested);
    expect(pushEvents).toHaveLength(1);
    expect(dto.status).toBe(InvoiceStatus.Approved);
  });

  it('rejects submitting an invoice that is not Validating/PendingReview', async () => {
    const repo = makeRepo(InvoiceStatus.Approved);
    const service = new InvoiceService(repo as never, makeApprovals());
    await expect(run(() => service.submit(INVOICE_ID))).rejects.toThrow(/Cannot submit/i);
  });
});

describe('decide → advance + complete', () => {
  it('approving a chain that COMPLETES advances to Approved, mirrors the trail, stages ERP push', async () => {
    const repo = makeRepo(InvoiceStatus.ForApproval);
    const approvals = makeApprovals();
    approvals.decide.mockResolvedValue({
      recordType: ApprovalRecordType.Invoice,
      recordId: INVOICE_ID,
      completed: true,
      outcome: 'approved',
      chain: [{ ...pendingSlot('approver-1'), status: 'approved' as never }],
    });
    const service = new InvoiceService(repo as never, approvals);

    const dto = await run(() => service.decide(INVOICE_ID, { decision: 'approved', comment: 'ok' }));

    expect(approvals.decide).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: ApprovalRecordType.Invoice, decision: 'approved', comment: 'ok' }),
    );
    // Mirrored onto the invoice's own ledger.
    expect(repo.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'approved', approval_level: 1, comment: 'ok' }),
      expect.anything(),
    );
    expect(repo.updateStatus).toHaveBeenCalledWith(
      INVOICE_ID,
      { status: InvoiceStatus.Approved },
      expect.anything(),
      expect.anything(), // W5-07 version-checked transition
    );
    const approved = stageOutboxEvent.mock.calls.map((c) => c[0]).filter((e) => e.topic === EventTopic.InvoiceApproved);
    expect(approved).toHaveLength(1);
    expect(dto.status).toBe(InvoiceStatus.Approved);
  });

  it('an approval that does NOT complete the chain keeps the invoice ForApproval (no status write, no push)', async () => {
    const repo = makeRepo(InvoiceStatus.ForApproval);
    const approvals = makeApprovals();
    approvals.decide.mockResolvedValue({
      recordType: ApprovalRecordType.Invoice,
      recordId: INVOICE_ID,
      completed: false,
      chain: [{ ...pendingSlot('approver-1', 1), status: 'approved' as never }, pendingSlot('senior-1', 2)],
    });
    const service = new InvoiceService(repo as never, approvals);

    const dto = await run(() => service.decide(INVOICE_ID, { decision: 'approved' }));

    expect(repo.createApproval).toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalledWith(
      INVOICE_ID,
      { status: InvoiceStatus.Approved },
      expect.anything(),
    );
    const pushEvents = stageOutboxEvent.mock.calls.map((c) => c[0]).filter((e) => e.topic === EventTopic.ConnectorPushRequested);
    expect(pushEvents).toHaveLength(0);
    expect(dto.status).toBe(InvoiceStatus.ForApproval);
  });

  it('rejecting a chain advances to Rejected and does NOT stage an ERP push', async () => {
    const repo = makeRepo(InvoiceStatus.ForApproval);
    const approvals = makeApprovals();
    approvals.decide.mockResolvedValue({
      recordType: ApprovalRecordType.Invoice,
      recordId: INVOICE_ID,
      completed: true,
      outcome: 'rejected',
      chain: [{ ...pendingSlot('approver-1'), status: 'rejected' as never }],
    });
    const service = new InvoiceService(repo as never, approvals);

    const dto = await run(() => service.decide(INVOICE_ID, { decision: 'rejected', comment: 'no PO' }));

    expect(repo.updateStatus).toHaveBeenCalledWith(
      INVOICE_ID,
      { status: InvoiceStatus.Rejected },
      expect.anything(),
      expect.anything(), // W5-07 version-checked transition
    );
    const pushEvents = stageOutboxEvent.mock.calls.map((c) => c[0]).filter((e) => e.topic === EventTopic.ConnectorPushRequested);
    expect(pushEvents).toHaveLength(0);
    expect(dto.status).toBe(InvoiceStatus.Rejected);
  });

  it('409s when the invoice is not ForApproval (decision is moot)', async () => {
    const repo = makeRepo(InvoiceStatus.Approved);
    const approvals = makeApprovals();
    const service = new InvoiceService(repo as never, approvals);
    await expect(run(() => service.decide(INVOICE_ID, { decision: 'approved' }))).rejects.toThrow(/Cannot approve/i);
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it('propagates the engine 403 when the principal is not a pending approver', async () => {
    const repo = makeRepo(InvoiceStatus.ForApproval);
    const approvals = makeApprovals();
    approvals.decide.mockRejectedValue(Object.assign(new Error('not a pending approver'), { type: 'forbidden' }));
    const service = new InvoiceService(repo as never, approvals);
    await expect(run(() => service.decide(INVOICE_ID, { decision: 'approved' }))).rejects.toThrow(/pending approver/i);
  });
});

describe('applyCompletion idempotency', () => {
  it('re-completing an already-Approved invoice is a no-op (no second status write / push)', async () => {
    const repo = makeRepo(InvoiceStatus.ForApproval);
    const approvals = makeApprovals();
    approvals.decide.mockResolvedValue({
      recordType: ApprovalRecordType.Invoice,
      recordId: INVOICE_ID,
      completed: true,
      outcome: 'approved',
      chain: [{ ...pendingSlot('approver-1'), status: 'approved' as never }],
    });
    // Pre-flight read = ForApproval; the completion re-read sees it already Approved (replay).
    repo.findById
      .mockResolvedValueOnce(invoiceRow({ status: InvoiceStatus.ForApproval }))
      .mockResolvedValue(invoiceRow({ status: InvoiceStatus.Approved }));
    const service = new InvoiceService(repo as never, approvals);

    await run(() => service.decide(INVOICE_ID, { decision: 'approved' }));

    expect(repo.updateStatus).not.toHaveBeenCalled();
    const pushEvents = stageOutboxEvent.mock.calls.map((c) => c[0]).filter((e) => e.topic === EventTopic.ConnectorPushRequested);
    expect(pushEvents).toHaveLength(0);
  });
});

describe('listPendingApprovals', () => {
  it("returns the current user's pending invoice slots hydrated with the invoice", async () => {
    const repo = makeRepo(InvoiceStatus.ForApproval);
    const approvals = makeApprovals();
    approvals.listPendingForApprover.mockResolvedValue([pendingSlot('approver-1', 1)]);
    const service = new InvoiceService(repo as never, approvals);

    const pending = await run(() => service.listPendingApprovals());

    expect(approvals.listPendingForApprover).toHaveBeenCalledWith('approver-1', ApprovalRecordType.Invoice);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ invoiceId: INVOICE_ID, level: 1 });
    expect(pending[0].invoice.id).toBe(INVOICE_ID);
  });

  it('drops RLS-invisible invoices from the inbox', async () => {
    const repo = makeRepo(InvoiceStatus.ForApproval);
    repo.findById.mockResolvedValue(null);
    const approvals = makeApprovals();
    approvals.listPendingForApprover.mockResolvedValue([pendingSlot('approver-1', 1)]);
    const service = new InvoiceService(repo as never, approvals);

    const pending = await run(() => service.listPendingApprovals());
    expect(pending).toHaveLength(0);
  });
});
