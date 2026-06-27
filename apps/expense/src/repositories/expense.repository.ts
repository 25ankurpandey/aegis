import type { Transaction } from 'sequelize';
import { ExpenseShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getExpenseContext } from '../models/database-context';

/**
 * Data access for the expense-item aggregate (the `expenses` table). Every method takes the
 * RLS-scoped `Transaction` opened by the SERVICE via `withTenantTransaction`, so `app.current_tenant`
 * is always set when these run.
 */
@provideSingleton(ExpenseRepository)
export class ExpenseRepository {
  async createExpense(
    data: ExpenseShape.CreateExpenseRow,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseRow> {
    const { Expense } = getExpenseContext();
    const row = await Expense.create(
      { ...data, assigned_to_report_at: data.report_id ? new Date() : null },
      { transaction: t },
    );
    return row.get({ plain: true }) as ExpenseShape.ExpenseRow;
  }

  async findExpenseById(id: string, t: Transaction): Promise<ExpenseShape.ExpenseRow | null> {
    const { Expense } = getExpenseContext();
    const row = await Expense.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as ExpenseShape.ExpenseRow) : null;
  }

  async attachExpenseToReport(
    expenseId: string,
    reportId: string,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseRow | null> {
    const { Expense } = getExpenseContext();
    const row = await Expense.findByPk(expenseId, { transaction: t });
    if (!row) return null;
    await row.update({ report_id: reportId, assigned_to_report_at: new Date() }, { transaction: t });
    return row.get({ plain: true }) as ExpenseShape.ExpenseRow;
  }

  async listExpensesForReport(reportId: string, t: Transaction): Promise<ExpenseShape.ExpenseRow[]> {
    const { Expense } = getExpenseContext();
    const rows = await Expense.findAll({ where: { report_id: reportId }, transaction: t });
    return rows.map((r) => r.get({ plain: true }) as ExpenseShape.ExpenseRow);
  }
}
