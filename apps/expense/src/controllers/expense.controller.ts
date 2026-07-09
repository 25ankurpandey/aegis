import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { routeParam, validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { withTenantTransaction } from '@aegis/db';
import type { AccessShape } from '@aegis/shared-types';
import { ExpenseService } from '../services/expense.service';
import { ExpenseRepository } from '../repositories/expense.repository';
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
    authorize(Permission.ExpenseReportView, { resource: (req) => loadExpenseResource(req) }),
    validate(expenseIdParamSchema, 'params'),
  )
  async getExpense(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.getExpense(routeParam(req, 'id')) });
  }
}

/**
 * Resource loader for the single expense-item read (SCOPE-03): surfaces the item's owner
 * (`created_by`) so the PEP row-scope check runs — an own_only principal is denied a line they did
 * not create (previously any viewer with the id could read it). The line's team lives on its parent
 * report, so own_and_team fail-closes to owner-only here (safe; a follow-up can join the report team).
 */
async function loadExpenseResource(req: Request): Promise<AccessShape.ResourceRef> {
  const id = routeParam(req, 'id');
  const repo = new ExpenseRepository();
  const expense = await withTenantTransaction((t) => repo.findExpenseById(id, t));
  return {
    type: 'expense',
    id,
    ownerId: expense?.created_by ?? undefined,
  };
}
