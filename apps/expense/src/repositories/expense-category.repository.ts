import type { Transaction } from 'sequelize';
import { ExpenseShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getExpenseContext } from '../models/database-context';

/**
 * Data access for the expense-category aggregate (the `expense_categories` table). Every method takes
 * the RLS-scoped `Transaction` opened by the SERVICE via `withTenantTransaction`.
 */
@provideSingleton(ExpenseCategoryRepository)
export class ExpenseCategoryRepository {
  async findCategoryById(id: string, t: Transaction): Promise<ExpenseShape.ExpenseCategoryRow | null> {
    const { ExpenseCategory } = getExpenseContext();
    const row = await ExpenseCategory.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as ExpenseShape.ExpenseCategoryRow) : null;
  }
}
