import 'reflect-metadata';
import type { Transaction } from 'sequelize';
import { ExpenseReportStatus } from '@aegis/shared-enums';
import { runInContext, TEST_TENANT, TEST_USER } from '@aegis/testing';
import type { ExpenseShape } from '@aegis/shared-types';

// withTenantTransaction just runs the callback with a fake transaction (no real DB in unit tests).
// getSequelize is stubbed so the transactional-outbox INSERT (stageOutboxEvent) is a harmless no-op.
jest.mock('@aegis/db', () => ({
  withTenantTransaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> =>
    fn({} as Transaction),
  getSequelize: () => ({ query: async () => [] }),
}));

// AuditLogger.record is a no-op in unit tests (covered by libs/audit specs).
const recordSpy = jest.fn().mockResolvedValue(undefined);
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: (...a: unknown[]) => recordSpy(...a) } }));

// ActivityLogger.record is a no-op in unit tests (covered by libs/activity specs).
const activitySpy = jest.fn().mockResolvedValue(undefined);
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: (...a: unknown[]) => activitySpy(...a) } }));

jest.mock('@aegis/connectors', () => ({
  ConnectorRegistry: { get: () => ({ pushTransaction: jest.fn() }) },
}));

import type { ApprovalService } from '@aegis/approvals';
import { ExpenseService } from '../../src/services/expense.service';
import type { ExpenseReportRepository } from '../../src/repositories/expense-report.repository';
import type { ExpenseRepository } from '../../src/repositories/expense.repository';

/** A stubbed approval engine (unused by the detail/comment/recall paths, but the ctor requires it). */
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

function reportRow(over: Partial<ExpenseShape.ExpenseReportRow> = {}): ExpenseShape.ExpenseReportRow {
  return {
    id: REPORT_ID,
    tenant_id: TEST_TENANT,
    report_number: '7',
    name: 'Q2 travel',
    status: ExpenseReportStatus.Approvals,
    submitter_id: TEST_USER,
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
  service: ExpenseService;
}

function makeService(status: ExpenseReportStatus, over: Partial<ExpenseShape.ExpenseReportRow> = {}): Fakes {
  const current = reportRow({ status, ...over });
  const reports = {
    findReportById: jest.fn().mockResolvedValue(current),
    updateReport: jest.fn().mockImplementation(async (_id, patch) => ({ ...current, ...patch })),
    createApproval: jest.fn().mockResolvedValue(undefined),
    createComment: jest.fn().mockImplementation(async (data) => ({
      id: 'c1',
      report_id: data.report_id,
      user_id: data.user_id,
      body: data.body,
      tenant_id: data.tenant_id,
      created_at: new Date('2026-06-26T00:00:00.000Z'),
    })),
    createActivity: jest.fn().mockResolvedValue(undefined),
    listApprovalsForReport: jest.fn().mockResolvedValue([]),
    listCommentsForReport: jest.fn().mockResolvedValue([]),
    listActivitiesForReport: jest.fn().mockResolvedValue([]),
    recomputeReportTotal: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<ExpenseReportRepository>;
  const expenses = {
    listExpensesForReport: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ExpenseRepository>;
  const service = new ExpenseService(reports, expenses, makeApprovals());
  return { reports, expenses, service };
}

describe('ExpenseService — detail / comments / recall (W3-13)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getReportDetail (W3-13a)', () => {
    it('assembles header + expenses + approvals + comments + activities in one read', async () => {
      const { service, reports, expenses } = makeService(ExpenseReportStatus.Approvals);
      expenses.listExpensesForReport.mockResolvedValue([
        {
          id: 'e1',
          tenant_id: TEST_TENANT,
          report_id: REPORT_ID,
          category_id: null,
          amount: '5000',
          currency: 'USD',
          merchant: 'Air',
          incurred_on: '2026-06-01',
          description: null,
          receipt_ref: null,
          created_by: TEST_USER,
          assigned_to_report_at: new Date(),
        },
      ]);
      reports.listApprovalsForReport.mockResolvedValue([
        {
          id: 'a1',
          tenant_id: TEST_TENANT,
          report_id: REPORT_ID,
          approver_id: 'mgr',
          decision: 'approved',
          level: 1,
          comment: 'ok',
          decided_at: new Date('2026-06-10T00:00:00.000Z'),
        },
      ]);
      reports.listCommentsForReport.mockResolvedValue([
        { id: 'cm1', tenant_id: TEST_TENANT, report_id: REPORT_ID, user_id: TEST_USER, body: 'hi', created_at: new Date('2026-06-09T00:00:00.000Z') },
      ]);
      reports.listActivitiesForReport.mockResolvedValue([
        { id: 'ac1', tenant_id: TEST_TENANT, report_id: REPORT_ID, user_id: TEST_USER, activity_type: 'report_created', details: {}, created_at: new Date('2026-06-08T00:00:00.000Z') },
      ]);

      const detail = await runInContext(() => service.getReportDetail(REPORT_ID));

      expect(detail.report.id).toBe(REPORT_ID);
      expect(detail.expenses).toHaveLength(1);
      expect(detail.expenses[0].id).toBe('e1');
      expect(detail.approvals[0]).toMatchObject({ id: 'a1', decision: 'approved', level: 1 });
      expect(detail.comments[0]).toMatchObject({ id: 'cm1', body: 'hi' });
      expect(detail.activities[0]).toMatchObject({ id: 'ac1', activityType: 'report_created' });
    });

    it('404s when the report is RLS-invisible', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approvals);
      reports.findReportById.mockResolvedValueOnce(null);
      await expect(runInContext(() => service.getReportDetail(REPORT_ID))).rejects.toThrow(/not found/i);
    });
  });

  describe('addComment / listComments (W3-13b)', () => {
    it('persists a comment and appends a comment_added activity', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approvals);

      const dto = await runInContext(() => service.addComment(REPORT_ID, { body: 'please fix' }));

      expect(reports.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ report_id: REPORT_ID, user_id: TEST_USER, body: 'please fix' }),
        expect.anything(),
      );
      expect(reports.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ activity_type: 'comment_added' }),
        expect.anything(),
      );
      expect(dto).toMatchObject({ body: 'please fix', reportId: REPORT_ID });
    });

    it('404s adding a comment to an RLS-invisible report', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approvals);
      reports.findReportById.mockResolvedValueOnce(null);
      await expect(
        runInContext(() => service.addComment(REPORT_ID, { body: 'x' })),
      ).rejects.toThrow(/not found/i);
    });

    it('lists comments oldest-first', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approvals);
      reports.listCommentsForReport.mockResolvedValue([
        { id: 'cm1', tenant_id: TEST_TENANT, report_id: REPORT_ID, user_id: TEST_USER, body: 'first', created_at: new Date('2026-06-01T00:00:00.000Z') },
      ]);
      const list = await runInContext(() => service.listComments(REPORT_ID));
      expect(list).toHaveLength(1);
      expect(list[0].body).toBe('first');
    });
  });

  describe('recallReport (W3-13c)', () => {
    it('moves APPROVALS → OPEN for the submitter, writes a recall activity + audit', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approvals, { submitter_id: TEST_USER });

      const dto = await runInContext(
        () => service.recallReport(REPORT_ID, { reason: 'need another line item' }),
        { roles: ['contributor'], userId: TEST_USER },
      );

      expect(reports.updateReport).toHaveBeenCalledWith(
        REPORT_ID,
        { status: ExpenseReportStatus.Open },
        expect.anything(),
      );
      expect(reports.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ activity_type: 'report_recalled' }),
        expect.anything(),
      );
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(dto.status).toBe(ExpenseReportStatus.Open);
    });

    it('forbids a non-submitter contributor from recalling', async () => {
      const { service } = makeService(ExpenseReportStatus.Approvals, { submitter_id: 'someone-else' });
      await expect(
        runInContext(() => service.recallReport(REPORT_ID, {}), { roles: ['contributor'], userId: TEST_USER }),
      ).rejects.toThrow();
    });

    it('rejects recalling an already-APPROVED report (not back to draft)', async () => {
      const { service } = makeService(ExpenseReportStatus.Approved, { submitter_id: TEST_USER });
      await expect(
        runInContext(() => service.recallReport(REPORT_ID, {}), { roles: ['contributor'], userId: TEST_USER }),
      ).rejects.toThrow();
    });

    it('rejects recalling a REIMBURSED report', async () => {
      const { service } = makeService(ExpenseReportStatus.Reimbursed, { submitter_id: TEST_USER });
      await expect(
        runInContext(() => service.recallReport(REPORT_ID, {}), { roles: ['contributor'], userId: TEST_USER }),
      ).rejects.toThrow();
    });

    it('404s when the report does not exist', async () => {
      const { service, reports } = makeService(ExpenseReportStatus.Approvals);
      reports.findReportById.mockResolvedValueOnce(null);
      await expect(runInContext(() => service.recallReport(REPORT_ID, {}))).rejects.toThrow(/not found/i);
    });
  });
});
