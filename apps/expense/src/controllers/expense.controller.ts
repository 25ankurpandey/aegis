import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { ExpenseService } from '../services/expense.service';
import { createExpenseSchema, expenseIdParamSchema } from '../validators/expense.validator';

/**
 * Expense-item HTTP surface. PEP-guarded (authenticate → authorize(permission) → handler) and the
 * request body validates via the `validate(...)` middleware. Tenant is ambient (RLS) — there is no
 * tenant path segment.
 */
@controller(`/expense${ApiConstants.PublicPrefix}`)
export class ExpenseController {
  constructor(@inject(ExpenseService) private readonly expense: ExpenseService) {}

  /** Add an expense item. */
  @httpPost('/expenses', authenticate(), authorize(Permission.ExpenseReportCreate), validate(createExpenseSchema))
  async createExpense(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.expense.createExpense(req.body) });
  }

  /** Read a single expense item (RLS-scoped). */
  @httpGet(
    '/expenses/:id',
    authenticate(),
    authorize(Permission.ExpenseReportView),
    validate(expenseIdParamSchema, 'params'),
  )
  async getExpense(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.getExpense(req.params['id']) });
  }
}
