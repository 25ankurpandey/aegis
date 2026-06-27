/**
 * W5-06 DUPLICATE-DETECTION CONCURRENCY GUARD.
 *
 * The serial `create()` does a read (`findDuplicateCandidate`) then a write — under concurrency two
 * submits of the same signature both pass the read and would both go live, paying the same bill
 * twice. The `invoices_dup_signature_live_uq` partial-unique index (0017) makes the loser's insert
 * raise a 23505; the service catches THAT and deterministically re-creates the loser as a Duplicate
 * linked to the live winner. These tests drive that catch path by having the repo throw a Sequelize
 * `UniqueConstraintError` for our index name, and assert the loser is resolved to Duplicate (not
 * surfaced as an error). The serial no-collision path is asserted unchanged. DB/events/audit/activity
 * are stubbed — no real Postgres.
 */
import { UniqueConstraintError } from 'sequelize';
import { InvoiceStatus, InvoiceActivityType } from '@aegis/shared-enums';

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
const activityRecord = jest.fn().mockResolvedValue(undefined);
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: (...a: unknown[]) => activityRecord(...a) } }));

import { RequestContext } from '@aegis/service-core';
import type { ApprovalService } from '@aegis/approvals';
import { InvoiceService } from '../../src/services/invoice.service';

const WINNER_ID = 'inv-winner';

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
    currency: 'USD',
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

const CREATE_INPUT = {
  vendorName: 'Acme',
  invoiceNumber: 'INV-100',
  invoiceDate: '2026-01-01',
  amountMinor: '12345',
  currency: 'USD',
};

function dedupViolation(): UniqueConstraintError {
  // Sequelize surfaces the violated index on `.index`; the service matches on our index name.
  return new UniqueConstraintError({
    message: 'duplicate key value violates unique constraint',
    errors: [],
    // @ts-expect-error — minimal shape; the service only reads `.index` / `.original.constraint`.
    parent: { constraint: 'invoices_dup_signature_live_uq' },
    fields: {},
  });
}

function makeApprovals(): ApprovalService {
  return { requestApproval: jest.fn(), decide: jest.fn(), listPendingForApprover: jest.fn() } as unknown as ApprovalService;
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'maker-1', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

beforeEach(() => {
  stageOutboxEvent.mockClear();
  activityRecord.mockClear();
});

describe('create() — serial (no collision)', () => {
  it('inserts live and advances Validating → PendingReview', async () => {
    const repo = {
      createInvoice: jest.fn().mockResolvedValue(invoiceRow()),
      createMetadata: jest.fn().mockResolvedValue(undefined),
      recordActivity: jest.fn().mockResolvedValue(undefined),
      findDuplicateCandidate: jest.fn().mockResolvedValue(null),
      createDuplicate: jest.fn(),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const service = new InvoiceService(repo as never, makeApprovals());

    const dto = await run(() => service.create(CREATE_INPUT as never));

    expect(repo.createDuplicate).not.toHaveBeenCalled();
    expect(dto.status).toBe(InvoiceStatus.PendingReview);
  });
});

describe('create() — concurrent-insert loser (W5-06 guard)', () => {
  it('catches the partial-unique violation and re-creates the loser as Duplicate linked to the winner', async () => {
    const index = (() => {
      const e = dedupViolation();
      // Also exercise the `.index` branch for drivers that set it.
      (e as { index?: string }).index = 'invoices_dup_signature_live_uq';
      return e;
    })();

    const repo = {
      // First (racing) insert hits the live partial-unique index → 23505. Recovery insert (status
      // Duplicate, excluded from the index) succeeds.
      createInvoice: jest
        .fn()
        .mockRejectedValueOnce(index)
        .mockResolvedValueOnce(invoiceRow({ id: 'inv-loser', status: InvoiceStatus.Duplicate })),
      createMetadata: jest.fn().mockResolvedValue(undefined),
      recordActivity: jest.fn().mockResolvedValue(undefined),
      // Recovery path resolves the live winner that won the signature.
      findDuplicateCandidate: jest.fn().mockResolvedValue(invoiceRow({ id: WINNER_ID, status: InvoiceStatus.PendingReview })),
      createDuplicate: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const service = new InvoiceService(repo as never, makeApprovals());

    const dto = await run(() => service.create(CREATE_INPUT as never));

    // Loser is deterministically marked Duplicate (not surfaced as an error).
    expect(dto.status).toBe(InvoiceStatus.Duplicate);
    // A duplicate-link row is written pointing at the live winner.
    expect(repo.createDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate_of: WINNER_ID }),
      expect.anything(),
    );
    // The DuplicateFlagged activity is recorded for the loser.
    expect(repo.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ activity_type: InvoiceActivityType.DuplicateFlagged, details: expect.objectContaining({ concurrent: true }) }),
      expect.anything(),
    );
    // Two createInvoice attempts: the racing live insert + the recovery Duplicate insert.
    expect(repo.createInvoice).toHaveBeenCalledTimes(2);
  });

  it('if the winner has since vanished (freed signature), retries the normal create', async () => {
    const repo = {
      createInvoice: jest
        .fn()
        .mockRejectedValueOnce(dedupViolation())
        .mockResolvedValueOnce(invoiceRow({ id: 'inv-loser' })),
      createMetadata: jest.fn().mockResolvedValue(undefined),
      recordActivity: jest.fn().mockResolvedValue(undefined),
      // No live winner anymore ⇒ recovery falls back to the normal create body (no collision now).
      findDuplicateCandidate: jest.fn().mockResolvedValue(null),
      createDuplicate: jest.fn(),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const service = new InvoiceService(repo as never, makeApprovals());

    const dto = await run(() => service.create(CREATE_INPUT as never));

    expect(repo.createDuplicate).not.toHaveBeenCalled();
    expect(dto.status).toBe(InvoiceStatus.PendingReview);
  });

  it('propagates an UNRELATED unique violation (not our dedup index) as a real error', async () => {
    const other = new UniqueConstraintError({
      message: 'duplicate key',
      errors: [],
      // @ts-expect-error — minimal shape
      parent: { constraint: 'some_other_uq' },
      fields: {},
    });
    const repo = {
      createInvoice: jest.fn().mockRejectedValue(other),
      createMetadata: jest.fn(),
      recordActivity: jest.fn(),
      findDuplicateCandidate: jest.fn(),
      createDuplicate: jest.fn(),
      updateStatus: jest.fn(),
    };
    const service = new InvoiceService(repo as never, makeApprovals());

    await expect(run(() => service.create(CREATE_INPUT as never))).rejects.toBe(other);
    expect(repo.createDuplicate).not.toHaveBeenCalled();
  });
});
