/**
 * BUG-0005 — `decide` SELF-HEAL of a stranded invoice.
 *
 * If the engine chain is ALREADY terminal but the invoice is still stranded in ForApproval (the
 * in-request advance failed after the vote committed), a retry must NOT re-vote (the engine would 409
 * "already decided"). `decide` first reads `getStatus`; if it reports completed+outcome it drives the
 * idempotent applyCompletion straight from the staged outcome and never calls `decide` on the engine.
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
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn() } }));
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('@aegis/connectors', () => ({ ConnectorRegistry: { get: () => ({ pushTransaction: jest.fn() }) } }));

import { RequestContext } from '@aegis/service-core';
import type { ApprovalService } from '@aegis/approvals';
import { InvoiceService } from '../../src/services/invoice.service';

const INVOICE_ID = 'inv-1';

function invoiceRow(status: InvoiceStatus) {
  return {
    id: INVOICE_ID, tenant_id: 't1', vendor_id: null, vendor_name: 'Acme', invoice_number: 'INV-100',
    invoice_date: '2026-01-01', due_date: null, amount_minor: '12345', currency: 'USD',
    transaction_type: 'debit', status, auto_approved: false, auto_approved_by: null,
    approval_policy_id: null, submitted_by: 'maker-1', created_by: 'maker-1', lock_version: 0,
    created_at: new Date(), updated_at: new Date(),
  };
}

function makeApprovals(): jest.Mocked<ApprovalService> {
  return {
    requestApproval: jest.fn(), decide: jest.fn(), getStatus: jest.fn(),
    listPendingForApprover: jest.fn().mockResolvedValue([]), reassign: jest.fn(), useResolver: jest.fn(),
  } as unknown as jest.Mocked<ApprovalService>;
}

function run<T>(fn: () => Promise<T>, userId = 'approver-1'): Promise<T> {
  return RequestContext.run({ tenantId: 't1', userId, correlationId: 'corr-1', startedAt: Date.now() } as never, fn);
}

beforeEach(() => stageOutboxEvent.mockClear());

it('advances a stranded ForApproval invoice via applyCompletion when the chain is already terminal, without re-voting', async () => {
  const repo = {
    findById: jest.fn().mockResolvedValue(invoiceRow(InvoiceStatus.ForApproval)),
    createApproval: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    recordActivity: jest.fn().mockResolvedValue(undefined),
  };
  const approvals = makeApprovals();
  // The engine chain is ALREADY approved, but the invoice is still stranded in ForApproval.
  approvals.getStatus.mockResolvedValue({
    recordType: ApprovalRecordType.Invoice, recordId: INVOICE_ID, mode: 'sequential' as never,
    minApprovals: 1, completed: true, outcome: 'approved',
    chain: [], history: [], votes: [],
  } as ApprovalShape.ChainStatus);
  const service = new InvoiceService(repo as never, approvals);

  const dto = await run(() => service.decide(INVOICE_ID, { decision: 'approved' }));

  // Self-heal path: NO re-vote.
  expect(approvals.decide).not.toHaveBeenCalled();
  // The stranded record is advanced to Approved + the ERP push is staged.
  expect(repo.updateStatus).toHaveBeenCalledWith(
    INVOICE_ID, { status: InvoiceStatus.Approved }, expect.anything(), expect.anything(),
  );
  const pushes = stageOutboxEvent.mock.calls.map((c) => c[0]).filter((e) => e.topic === EventTopic.ConnectorPushRequested);
  expect(pushes).toHaveLength(1);
  expect(dto.status).toBe(InvoiceStatus.Approved);
});
