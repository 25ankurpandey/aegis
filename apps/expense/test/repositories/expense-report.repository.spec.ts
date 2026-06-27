import 'reflect-metadata';
import type { Transaction } from 'sequelize';

// Stub the model context so the repository runs against in-memory fakes (no real DB / connection).
const Expense = {
  findAll: jest.fn(),
  sum: jest.fn(),
};
const ExpenseReport = {
  findByPk: jest.fn(),
};
const ExpenseApproval = { findAll: jest.fn() };
const ExpenseComment = { findAll: jest.fn() };
const ExpenseActivity = { findAll: jest.fn() };
jest.mock('../../src/models/database-context', () => ({
  getExpenseContext: () => ({ Expense, ExpenseReport, ExpenseApproval, ExpenseComment, ExpenseActivity }),
}));

import { ExpenseReportRepository } from '../../src/repositories/expense-report.repository';

const REPORT_ID = '11111111-1111-4111-8111-111111111111';
const t = {} as Transaction;

describe('ExpenseReportRepository.recomputeReportTotal (W1-10)', () => {
  let repo: ExpenseReportRepository;
  let reportRow: { update: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new ExpenseReportRepository();
    reportRow = { update: jest.fn().mockResolvedValue(undefined), get: () => ({}) } as never;
    ExpenseReport.findByPk.mockResolvedValue(reportRow);
  });

  it('sums and persists the total when all items share one currency', async () => {
    Expense.findAll.mockResolvedValue([{ currency: 'USD' }]);
    Expense.sum.mockResolvedValue(7500);

    const total = await repo.recomputeReportTotal(REPORT_ID, t);

    expect(total).toBe(7500);
    expect(reportRow.update).toHaveBeenCalledWith({ total_amount: 7500 }, { transaction: t });
  });

  it('treats an empty report as a zero total', async () => {
    Expense.findAll.mockResolvedValue([]);
    Expense.sum.mockResolvedValue(null);

    const total = await repo.recomputeReportTotal(REPORT_ID, t);

    expect(total).toBe(0);
    expect(reportRow.update).toHaveBeenCalledWith({ total_amount: 0 }, { transaction: t });
  });

  it('refuses to total a report whose items span more than one currency', async () => {
    Expense.findAll.mockResolvedValue([{ currency: 'USD' }, { currency: 'EUR' }]);

    await expect(repo.recomputeReportTotal(REPORT_ID, t)).rejects.toThrow(/mixing currencies/i);
    // Never sums or persists a meaningless cross-currency total.
    expect(Expense.sum).not.toHaveBeenCalled();
    expect(reportRow.update).not.toHaveBeenCalled();
  });
});

describe('ExpenseReportRepository detail reads (W3-13)', () => {
  let repo: ExpenseReportRepository;
  const plain = (o: object) => ({ get: () => o });

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new ExpenseReportRepository();
  });

  it('lists approvals ordered by level then decided_at', async () => {
    ExpenseApproval.findAll.mockResolvedValue([plain({ id: 'a1' })]);
    const rows = await repo.listApprovalsForReport(REPORT_ID, t);
    expect(rows).toEqual([{ id: 'a1' }]);
    expect(ExpenseApproval.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { report_id: REPORT_ID },
        order: [
          ['level', 'ASC'],
          ['decided_at', 'ASC'],
        ],
        transaction: t,
      }),
    );
  });

  it('lists comments oldest-first', async () => {
    ExpenseComment.findAll.mockResolvedValue([plain({ id: 'c1' })]);
    const rows = await repo.listCommentsForReport(REPORT_ID, t);
    expect(rows).toEqual([{ id: 'c1' }]);
    expect(ExpenseComment.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { report_id: REPORT_ID },
        order: [['created_at', 'ASC']],
        transaction: t,
      }),
    );
  });

  it('lists activities oldest-first', async () => {
    ExpenseActivity.findAll.mockResolvedValue([plain({ id: 'ac1' })]);
    const rows = await repo.listActivitiesForReport(REPORT_ID, t);
    expect(rows).toEqual([{ id: 'ac1' }]);
    expect(ExpenseActivity.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { report_id: REPORT_ID },
        order: [['created_at', 'ASC']],
        transaction: t,
      }),
    );
  });
});
