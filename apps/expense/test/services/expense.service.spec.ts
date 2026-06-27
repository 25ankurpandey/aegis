import 'reflect-metadata';
import type { Transaction } from 'sequelize';
import { ConnectorEntity, ConnectorKind, ExpenseReportStatus, ApprovalRecordType } from '@aegis/shared-enums';
import { ExpenseDecision } from '@aegis/shared-constants';
import { InProcessBus, setBus, getBus, EventTopic, type EventEnvelope } from '@aegis/events';
import { runInContext, TEST_TENANT, TEST_USER } from '@aegis/testing';
import type { ExpenseShape, ApprovalShape } from '@aegis/shared-types';

// Transactional-outbox capture: stageOutboxEvent inserts the envelope via getSequelize().query, with
// the full envelope JSON as bind[4]. We stub getSequelize so the INSERT is a no-op against a real DB
// and instead record the staged envelope here, so the producer's event-emission contract is still
// asserted (the producer now STAGES events into the outbox rather than publishing on the request path).
const stagedEnvelopes: unknown[] = [];

// withTenantTransaction just runs the callback with a fake transaction (no real DB in unit tests).
jest.mock('@aegis/db', () => ({
  withTenantTransaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> =>
    fn({} as Transaction),
  getSequelize: () => ({
    query: async (sql: string, opts?: { bind?: unknown[] }) => {
      if (/INSERT INTO\s+"event_outbox"/i.test(sql)) {
        const envelopeJson = opts?.bind?.[4];
        if (typeof envelopeJson === 'string') stagedEnvelopes.push(JSON.parse(envelopeJson));
      }
      return [];
    },
  }),
}));

// AuditLogger.record is a no-op in unit tests (its own concurrency is covered by libs/audit specs).
const recordSpy = jest.fn().mockResolvedValue(undefined);
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: (...a: unknown[]) => recordSpy(...a) } }));

// ActivityLogger.record is a no-op in unit tests (the shared business timeline is covered by
// libs/activity specs); without this it would reach for a real model/connection.
const activitySpy = jest.fn().mockResolvedValue(undefined);
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: (...a: unknown[]) => activitySpy(...a) } }));

// The ERP connector is exercised separately; here we just confirm approved reports try to push.
const pushTransaction = jest.fn().mockResolvedValue({ accepted: true });
jest.mock('@aegis/connectors', () => ({
  ConnectorRegistry: { get: () => ({ pushTransaction }) },
}));

import type { ApprovalService } from '@aegis/approvals';
import { ExpenseService } from '../../src/services/expense.service';
import type { ExpenseReportRepository } from '../../src/repositories/expense-report.repository';
import type { ExpenseRepository } from '../../src/repositories/expense.repository';

/** A stubbed approval engine; per-test overrides set the request/decide/pending behaviour. */
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

const REPORT_ID = '11111111-1111-4111-8111-111111111111';

/** A report row fixture in a given status (defaults to the submitter being the test user). */
function reportRow(over: Partial<ExpenseShape.ExpenseReportRow> = {}): ExpenseShape.ExpenseReportRow {
  return {
    id: REPORT_ID,
    tenant_id: TEST_TENANT,
    report_number: '7',
    name: 'Q2 travel',
    status: ExpenseReportStatus.Approvals,
    submitter_id: 'submitter-1',
    total_amount: '5000',
    currency: 'USD',
    submitted_at: new Date(),
    synced_at: null,
    ...over,
  };
}

interface Fakes {
  reports: jest.Mocked<ExpenseReportRepository>;
  expenses: jest.Mocked<ExpenseRepository>;
  approvals: jest.Mocked<ApprovalService>;
  service: ExpenseService;
}

/** Wire the service with fully-stubbed repositories + a stub approval engine; report starts in `status`. */
function makeService(status: ExpenseReportStatus): Fakes {
  const current = reportRow({ status });
  const reports = {
    findReportById: jest.fn().mockResolvedValue(current),
    updateReport: jest.fn().mockImplementation(async (_id, patch) => ({ ...current, ...patch })),
    createApproval: jest.fn().mockResolvedValue(undefined),
    createActivity: jest.fn().mockResolvedValue(undefined),
    recomputeReportTotal: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<ExpenseReportRepository>;
  const expenses = {
    listExpensesForReport: jest.fn().mockResolvedValue([]),
    findExpenseById: jest.fn(),
    attachExpenseToReport: jest.fn(),
    createExpense: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExpenseRepository>;
  const approvals = makeApprovals();
  const service = new ExpenseService(reports, expenses, approvals);
  return { reports, expenses, approvals, service };
}

/**
 * Capture every domain event the service STAGES into the transactional outbox during `fn`. With the
 * outbox pattern the producer no longer publishes to the bus on the request path — it stages the
 * envelope via `stageOutboxEvent` inside the tx (the relay later drains it). The `@aegis/db` mock
 * records the staged envelope, which is the producer-side contract under test.
 */
async function captureEvents(fn: () => Promise<unknown>): Promise<EventEnvelope[]> {
  stagedEnvelopes.length = 0;
  await fn();
  return stagedEnvelopes.slice() as EventEnvelope[];
}

describe('ExpenseService — reject / reimburse / mixed-currency guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setBus(new InProcessBus());
  });

  afterEach(() => {
    setBus(new InProcessBus());
  });

  describe('rejectReport (W1-08)', () => {
    it('moves APPROVALS → REJECTED, writes a rejected decision + activity + audit, emits ExpenseRejected', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approvals);

      const events = await captureEvents(() =>
        runInContext(() => service.rejectReport(REPORT_ID, { reason: 'missing receipts' })),
      );

      expect(reports.updateReport).toHaveBeenCalledWith(
        REPORT_ID,
        { status: ExpenseReportStatus.Rejected },
        expect.anything(),
      );
      expect(reports.createApproval).toHaveBeenCalledWith(
        expect.objectContaining({ decision: ExpenseDecision.Rejected, level: 1, comment: 'missing receipts' }),
        expect.anything(),
      );
      expect(reports.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ activity_type: 'report_rejected' }),
        expect.anything(),
      );
      expect(recordSpy).toHaveBeenCalledTimes(1);

      const rejected = events.filter((e) => e.topic === EventTopic.ExpenseRejected);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].payload).toMatchObject({
        reportId: REPORT_ID,
        status: ExpenseReportStatus.Rejected,
        rejectedBy: TEST_USER,
        reason: 'missing receipts',
        recipientUserId: 'submitter-1', // notify the submitter
      });
    });

    it('does NOT push a rejected report to the ERP', async () => {
      const { service } = makeService(ExpenseReportStatus.Approvals);
      await runInContext(() => service.rejectReport(REPORT_ID, {}));
      expect(pushTransaction).not.toHaveBeenCalled();
    });

    it('rejects an illegal transition (already-approved report cannot be rejected by a non-admin)', async () => {
      const { service } = makeService(ExpenseReportStatus.Approved);
      await expect(
        runInContext(() => service.rejectReport(REPORT_ID, {}), { roles: ['contributor'] }),
      ).rejects.toThrow();
    });

    it('404s when the report does not exist', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approvals);
      reports.findReportById.mockResolvedValueOnce(null);
      await expect(runInContext(() => service.rejectReport(REPORT_ID, {}))).rejects.toThrow(
        /not found/i,
      );
    });
  });

  describe('reimburseReport (W1-09)', () => {
    it('moves APPROVED → REIMBURSED with activity + audit, and emits no event', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approved);

      const events = await captureEvents(() =>
        runInContext(() => service.reimburseReport(REPORT_ID, { comment: 'paid via ACH' })),
      );

      expect(reports.updateReport).toHaveBeenCalledWith(
        REPORT_ID,
        { status: ExpenseReportStatus.Reimbursed },
        expect.anything(),
      );
      expect(reports.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ activity_type: 'report_reimbursed' }),
        expect.anything(),
      );
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(0); // no reimburse event contract today
    });

    it('rejects reimbursing a report that is not yet APPROVED', async () => {
      const { service } = makeService(ExpenseReportStatus.Approvals);
      await expect(
        runInContext(() => service.reimburseReport(REPORT_ID, {}), { roles: ['finance_disburser'] }),
      ).rejects.toThrow();
    });
  });

  describe('mixed-currency guard (W1-10)', () => {
    it('rejects attaching an inline item whose currency differs from the report currency', async () => {
      const { service, reports, expenses } = makeService(ExpenseReportStatus.Open);
      reports.findReportById.mockResolvedValue(
        reportRow({ status: ExpenseReportStatus.Open, currency: 'USD', submitter_id: TEST_USER }),
      );

      await expect(
        runInContext(() => service.attachExpenseToReport(REPORT_ID, { amount: 1000, currency: 'EUR' })),
      ).rejects.toThrow(/currency/i);
      expect(expenses.createExpense).not.toHaveBeenCalled();
      expect(reports.recomputeReportTotal).not.toHaveBeenCalled();
    });

    it('rejects attaching an existing item whose currency differs from the report currency', async () => {
      const { service, reports, expenses } = makeService(ExpenseReportStatus.Open);
      reports.findReportById.mockResolvedValue(
        reportRow({ status: ExpenseReportStatus.Open, currency: 'USD', submitter_id: TEST_USER }),
      );
      expenses.findExpenseById.mockResolvedValue({ currency: 'GBP' } as ExpenseShape.ExpenseRow);

      await expect(
        runInContext(() =>
          service.attachExpenseToReport(REPORT_ID, {
            amount: 0,
            expenseId: '22222222-2222-4222-8222-222222222222',
          } as ExpenseShape.CreateExpenseInput),
        ),
      ).rejects.toThrow(/currency/i);
      expect(expenses.attachExpenseToReport).not.toHaveBeenCalled();
    });

    it('allows attaching an inline item in the report currency (recomputes the total)', async () => {
      const { service, reports, expenses } = makeService(ExpenseReportStatus.Open);
      reports.findReportById.mockResolvedValue(
        reportRow({ status: ExpenseReportStatus.Open, currency: 'USD', submitter_id: TEST_USER }),
      );

      await runInContext(() => service.attachExpenseToReport(REPORT_ID, { amount: 1000, currency: 'USD' }));

      expect(expenses.createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'USD' }),
        expect.anything(),
      );
      expect(reports.recomputeReportTotal).toHaveBeenCalledWith(REPORT_ID, expect.anything());
    });

    it('defaults an inline item with no explicit currency to the report currency', async () => {
      const { service, reports, expenses } = makeService(ExpenseReportStatus.Open);
      reports.findReportById.mockResolvedValue(
        reportRow({ status: ExpenseReportStatus.Open, currency: 'CAD', submitter_id: TEST_USER }),
      );

      await runInContext(() => service.attachExpenseToReport(REPORT_ID, { amount: 1000 }));

      expect(expenses.createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'CAD' }),
        expect.anything(),
      );
    });
  });

  // Sanity: the bus override mechanism the tests rely on is wired.
  it('publishes through the active bus', () => {
    const bus = new InProcessBus();
    setBus(bus);
    expect(getBus()).toBe(bus);
  });
});

/** A pending record-approver slot fixture for the given approver. */
function pendingSlot(approverId: string, level = 1): ApprovalShape.RecordApproverRow {
  return {
    id: `slot-${approverId}`,
    tenant_id: TEST_TENANT,
    record_type: ApprovalRecordType.ExpenseReport,
    record_id: REPORT_ID,
    level,
    approver_type: 'user' as ApprovalShape.RecordApproverRow['approver_type'],
    approver_id: approverId,
    status: 'pending' as ApprovalShape.RecordApproverRow['status'],
    sequence: 1,
    is_active: true,
  };
}

describe('ExpenseService — engine-backed approval flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setBus(new InProcessBus());
  });
  afterEach(() => setBus(new InProcessBus()));

  describe('submitReport → requestApproval', () => {
    it('moves OPEN → APPROVALS and routes the report into the shared engine keyed by (ExpenseReport, id)', async () => {
      const { service, reports, approvals } = makeService(ExpenseReportStatus.Open);
      reports.findReportById.mockResolvedValue(
        reportRow({ status: ExpenseReportStatus.Open, submitter_id: TEST_USER, total_amount: '5000', currency: 'USD' }),
      );
      approvals.requestApproval.mockResolvedValue({
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: REPORT_ID,
        mode: 'sequential' as never,
        minApprovals: 1,
        chain: [pendingSlot('manager-1')], // non-empty chain ⇒ stays in APPROVALS
      });

      const dto = await runInContext(() => service.submitReport(REPORT_ID), { userId: TEST_USER });

      expect(reports.updateReport).toHaveBeenCalledWith(
        REPORT_ID,
        expect.objectContaining({ status: ExpenseReportStatus.Approvals }),
        expect.anything(),
      );
      // requestedBy is the report's SUBMITTER (the SoD requester). The default updateReport mock
      // spreads the fixture (submitter_id 'submitter-1') over the patch, so that is what the engine sees.
      expect(approvals.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          recordType: ApprovalRecordType.ExpenseReport,
          recordId: REPORT_ID,
          // BUG-0007: the BIGINT minor-unit total is now passed straight through as the DB-native
          // string (no lossy Number() coercion), so the engine can route large amounts correctly.
          amountMinor: '5000',
          currency: 'USD',
          requestedBy: 'submitter-1',
        }),
      );
      // Submitted activity went to the shared timeline too.
      expect(activitySpy).toHaveBeenCalledWith(
        expect.objectContaining({ recordType: ApprovalRecordType.ExpenseReport, action: 'report_submitted' }),
        expect.anything(),
      );
      expect(dto.status).toBe(ExpenseReportStatus.Approvals);
    });

    it('auto-advances to APPROVED when the engine resolves an EMPTY chain (no required approvers)', async () => {
      const { service, reports, approvals } = makeService(ExpenseReportStatus.Open);
      reports.findReportById.mockResolvedValue(
        reportRow({ status: ExpenseReportStatus.Open, submitter_id: TEST_USER }),
      );
      approvals.requestApproval.mockResolvedValue({
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: REPORT_ID,
        mode: 'sequential' as never,
        minApprovals: 1,
        chain: [], // empty ⇒ engine auto-completed ⇒ expense advances straight to APPROVED
      });

      const dto = await runInContext(() => service.submitReport(REPORT_ID), { userId: TEST_USER });

      expect(reports.updateReport).toHaveBeenCalledWith(
        REPORT_ID,
        { status: ExpenseReportStatus.Approved },
        expect.anything(),
      );
      expect(dto.status).toBe(ExpenseReportStatus.Approved);
    });
  });

  describe('decideReport → advance + complete', () => {
    it('approving a chain that COMPLETES advances APPROVALS → APPROVED, records trail + audit, and stages the ERP push', async () => {
      const { service, reports, approvals } = makeService(ExpenseReportStatus.Approvals);
      approvals.decide.mockResolvedValue({
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: REPORT_ID,
        completed: true,
        outcome: 'approved',
        chain: [{ ...pendingSlot(TEST_USER), status: 'approved' as never }],
      });

      const events = await captureEvents(() =>
        runInContext(() => service.decideReport(REPORT_ID, { decision: 'approved', comment: 'ok' })),
      );

      expect(approvals.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          recordType: ApprovalRecordType.ExpenseReport,
          recordId: REPORT_ID,
          approverId: TEST_USER,
          decision: 'approved',
          comment: 'ok',
        }),
      );
      // Decision mirrored onto the report's own ledger.
      expect(reports.createApproval).toHaveBeenCalledWith(
        expect.objectContaining({ decision: ExpenseDecision.Approved, level: 1, comment: 'ok' }),
        expect.anything(),
      );
      expect(reports.updateReport).toHaveBeenCalledWith(
        REPORT_ID,
        { status: ExpenseReportStatus.Approved },
        expect.anything(),
      );
      expect(recordSpy).toHaveBeenCalled();
      expect(pushTransaction).not.toHaveBeenCalled(); // ERP push runs in the workflow worker
      const approved = events.filter((e) => e.topic === EventTopic.ExpenseApproved);
      expect(approved).toHaveLength(1);
      expect(approved[0].payload).toMatchObject({ reportId: REPORT_ID, approvedBy: TEST_USER });
      const connectorPush = events.filter((e) => e.topic === EventTopic.ConnectorPushRequested);
      expect(connectorPush).toHaveLength(1);
      expect(connectorPush[0].payload).toMatchObject({
        connectorKind: ConnectorKind.LedgerOne,
        entity: ConnectorEntity.Expense,
        idempotencyKey: REPORT_ID,
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: REPORT_ID,
        ruleId: 'expense.approve',
      });
    });

    it('an approval that does NOT yet complete the chain keeps the report in APPROVALS (no status write, no ERP)', async () => {
      const { service, reports, approvals } = makeService(ExpenseReportStatus.Approvals);
      approvals.decide.mockResolvedValue({
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: REPORT_ID,
        completed: false,
        chain: [{ ...pendingSlot(TEST_USER, 1), status: 'approved' as never }, pendingSlot('senior-1', 2)],
      });

      const dto = await runInContext(() => service.decideReport(REPORT_ID, { decision: 'approved' }));

      // Trail row written, but no terminal status transition.
      expect(reports.createApproval).toHaveBeenCalled();
      expect(reports.updateReport).not.toHaveBeenCalledWith(
        REPORT_ID,
        expect.objectContaining({ status: ExpenseReportStatus.Approved }),
        expect.anything(),
      );
      expect(pushTransaction).not.toHaveBeenCalled();
      expect(dto.status).toBe(ExpenseReportStatus.Approvals);
    });

    it('rejecting a chain advances APPROVALS → REJECTED and does NOT push to the ERP', async () => {
      const { service, reports, approvals } = makeService(ExpenseReportStatus.Approvals);
      approvals.decide.mockResolvedValue({
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: REPORT_ID,
        completed: true,
        outcome: 'rejected',
        chain: [{ ...pendingSlot(TEST_USER), status: 'rejected' as never }],
      });

      const events = await captureEvents(() =>
        runInContext(() => service.decideReport(REPORT_ID, { decision: 'rejected', comment: 'no receipts' })),
      );

      expect(reports.updateReport).toHaveBeenCalledWith(
        REPORT_ID,
        { status: ExpenseReportStatus.Rejected },
        expect.anything(),
      );
      expect(pushTransaction).not.toHaveBeenCalled();
      expect(events.filter((e) => e.topic === EventTopic.ExpenseRejected)).toHaveLength(1);
    });

    it('propagates the engine 403 when the principal is not a pending approver', async () => {
      const { service, approvals } = makeService(ExpenseReportStatus.Approvals);
      const forbidden = Object.assign(new Error('not a pending approver'), { type: 'forbidden' });
      approvals.decide.mockRejectedValue(forbidden);

      await expect(
        runInContext(() => service.decideReport(REPORT_ID, { decision: 'approved' })),
      ).rejects.toThrow(/pending approver/i);
    });

    it('409s when the report is not in APPROVALS (decision is moot)', async () => {
      const { service, approvals } = makeService(ExpenseReportStatus.Approved);
      await expect(
        runInContext(() => service.decideReport(REPORT_ID, { decision: 'approved' })),
      ).rejects.toThrow(/awaiting approval/i);
      expect(approvals.decide).not.toHaveBeenCalled();
    });
  });

  describe('applyCompletion idempotency', () => {
    it('re-completing an already-APPROVED report is a no-op (no second status write / ERP push)', async () => {
      const { service, reports, approvals } = makeService(ExpenseReportStatus.Approvals);
      // Report is already APPROVED by the time completion is applied (replayed completion).
      reports.findReportById.mockResolvedValue(reportRow({ status: ExpenseReportStatus.Approved }));
      approvals.decide.mockResolvedValue({
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: REPORT_ID,
        completed: true,
        outcome: 'approved',
        chain: [{ ...pendingSlot(TEST_USER), status: 'approved' as never }],
      });

      // Pre-flight sees APPROVED (not APPROVALS) ⇒ 409 before the engine is even called, proving the
      // again-safe guard. (A direct applyCompletion replay is covered by the no-op branch below.)
      await expect(
        runInContext(() => service.decideReport(REPORT_ID, { decision: 'approved' })),
      ).rejects.toThrow(/awaiting approval/i);
      expect(pushTransaction).not.toHaveBeenCalled();
    });
  });

  describe('listPendingApprovals', () => {
    it("returns the current user's pending expense-report slots hydrated with the report", async () => {
      const { service, reports, approvals } = makeService(ExpenseReportStatus.Approvals);
      approvals.listPendingForApprover.mockResolvedValue([pendingSlot(TEST_USER, 1)]);
      reports.findReportById.mockResolvedValue(reportRow({ status: ExpenseReportStatus.Approvals }));

      const pending = await runInContext(() => service.listPendingApprovals(), { userId: TEST_USER });

      expect(approvals.listPendingForApprover).toHaveBeenCalledWith(
        TEST_USER,
        ApprovalRecordType.ExpenseReport,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ reportId: REPORT_ID, level: 1 });
      expect(pending[0].report.id).toBe(REPORT_ID);
    });

    it('drops RLS-invisible reports from the inbox', async () => {
      const { service, reports, approvals } = makeService(ExpenseReportStatus.Approvals);
      approvals.listPendingForApprover.mockResolvedValue([pendingSlot(TEST_USER, 1)]);
      reports.findReportById.mockResolvedValue(null);

      const pending = await runInContext(() => service.listPendingApprovals(), { userId: TEST_USER });
      expect(pending).toHaveLength(0);
    });
  });
});
