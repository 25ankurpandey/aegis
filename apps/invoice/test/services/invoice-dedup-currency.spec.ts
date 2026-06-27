/**
 * BUG-0010 — DUPLICATE DETECTION MUST INCLUDE CURRENCY.
 *
 * The dedup SIGNATURE hashes (vendor + number + amount + CURRENCY), but the enforcement read
 * (`findDuplicateCandidate`) and the 0017 partial-unique index omitted currency, so a legitimate
 * invoice with the SAME vendor/number/amount but a DIFFERENT currency collided with the existing one,
 * was wrongly flagged `Duplicate`, and was never paid.
 *
 * These tests assert the service now (a) passes `currency` into the dedup read so the WHERE can
 * scope by currency, and (b) behaves correctly given a currency-scoped read: a different-currency
 * invoice (the read finds no same-currency candidate) advances to PendingReview, while an identical
 * invoice incl. currency (the read finds a candidate) is flagged Duplicate. DB/events/audit/activity
 * are stubbed — no real Postgres.
 */
import { InvoiceStatus } from '@aegis/shared-enums';

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

import { RequestContext } from '@aegis/service-core';
import type { ApprovalService } from '@aegis/approvals';
import { InvoiceService } from '../../src/services/invoice.service';

const WINNER_ID = 'inv-usd-original';

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-new',
    tenant_id: 't1',
    vendor_id: null,
    vendor_name: 'Acme',
    invoice_number: 'INV-100',
    invoice_date: '2026-01-01',
    due_date: null,
    amount_minor: '12345',
    currency: 'EUR',
    transaction_type: 'debit',
    status: InvoiceStatus.Received,
    auto_approved: false,
    auto_approved_by: null,
    approval_policy_id: null,
    submitted_by: null,
    created_by: 'maker-1',
    lock_version: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

// Same vendor / number / amount as a hypothetical existing USD invoice, but billed in EUR.
const EUR_INPUT = {
  vendorName: 'Acme',
  invoiceNumber: 'INV-100',
  invoiceDate: '2026-01-01',
  amountMinor: '12345',
  currency: 'EUR',
};

const USD_INPUT = { ...EUR_INPUT, currency: 'USD' };

function makeApprovals(): ApprovalService {
  return { requestApproval: jest.fn(), decide: jest.fn(), getStatus: jest.fn(), listPendingForApprover: jest.fn() } as unknown as ApprovalService;
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'maker-1', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

beforeEach(() => stageOutboxEvent.mockClear());

describe('create() — currency is part of the dedup signature (BUG-0010)', () => {
  it('passes currency into the dedup read so a different-currency invoice can be distinguished', async () => {
    const repo = {
      createInvoice: jest.fn().mockResolvedValue(invoiceRow({ currency: 'EUR' })),
      createMetadata: jest.fn().mockResolvedValue(undefined),
      recordActivity: jest.fn().mockResolvedValue(undefined),
      // A currency-scoped read finds NO same-currency (EUR) candidate — the USD original is excluded.
      findDuplicateCandidate: jest.fn().mockResolvedValue(null),
      createDuplicate: jest.fn(),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const service = new InvoiceService(repo as never, makeApprovals());

    const dto = await run(() => service.create(EUR_INPUT as never));

    // The dedup read MUST carry currency (so the WHERE / index can scope by it).
    expect(repo.findDuplicateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ vendorName: 'Acme', invoiceNumber: 'INV-100', currency: 'EUR' }),
      expect.anything(),
    );
    // A legit different-currency invoice is NOT a duplicate — it proceeds to review/approval.
    expect(repo.createDuplicate).not.toHaveBeenCalled();
    expect(dto.status).toBe(InvoiceStatus.PendingReview);
  });

  it('still flags a TRUE duplicate (identical incl. currency) as Duplicate', async () => {
    const repo = {
      createInvoice: jest.fn().mockResolvedValue(invoiceRow({ currency: 'USD' })),
      createMetadata: jest.fn().mockResolvedValue(undefined),
      recordActivity: jest.fn().mockResolvedValue(undefined),
      // A same-currency (USD) original exists ⇒ the read returns it ⇒ this invoice is the duplicate.
      findDuplicateCandidate: jest.fn().mockResolvedValue(invoiceRow({ id: WINNER_ID, currency: 'USD', status: InvoiceStatus.PendingReview })),
      createDuplicate: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const service = new InvoiceService(repo as never, makeApprovals());

    const dto = await run(() => service.create(USD_INPUT as never));

    expect(repo.findDuplicateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' }),
      expect.anything(),
    );
    expect(repo.createDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate_of: WINNER_ID }),
      expect.anything(),
    );
    expect(dto.status).toBe(InvoiceStatus.Duplicate);
  });
});
