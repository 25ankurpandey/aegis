import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { getSequelize, createModelRegistry } from '@aegis/db';
import { defineExpenseReport } from './expense-report.model';
import { defineExpense } from './expense.model';
import { defineExpenseCategory } from './expense-category.model';
import { defineExpenseApproval } from './expense-approval.model';
import { defineExpenseComment } from './expense-comment.model';
import { defineExpenseActivity } from './expense-activity.model';

type M = ModelStatic<Model>;

/** The set of expense models, registered on the shared connection (the service's DatabaseContext). */
export interface ExpenseContext {
  ExpenseReport: M;
  Expense: M;
  ExpenseCategory: M;
  ExpenseApproval: M;
  ExpenseComment: M;
  ExpenseActivity: M;
  sequelize: Sequelize;
}

let ctx: ExpenseContext | null = null;

/**
 * Defines every expense model on the shared `getSequelize()` connection (once), wires the
 * associations, and returns the assembled context. The return shape is unchanged from the previous
 * single-file `context.ts`, so all callers keep working (SPEC §11.1 — one `*.model.ts` per table +
 * a `database-context.ts` that imports + registers them). Money columns are BIGINT integer minor
 * units; PKs are UUID v4; all tables are tenant-scoped + RLS.
 */
export function getExpenseContext(): ExpenseContext {
  if (ctx) return ctx;
  const s = getSequelize();
  // Single registration path: shared base-model options (timestamps/underscored/paranoid/version)
  // applied + tracked consistently through the registry (W2-09).
  const registry = createModelRegistry(s);

  const ExpenseReport = registry.register(defineExpenseReport(s));
  const Expense = registry.register(defineExpense(s));
  const ExpenseCategory = registry.register(defineExpenseCategory(s));
  const ExpenseApproval = registry.register(defineExpenseApproval(s));
  const ExpenseComment = registry.register(defineExpenseComment(s));
  const ExpenseActivity = registry.register(defineExpenseActivity(s));

  ExpenseReport.hasMany(Expense, { foreignKey: 'report_id', as: 'expenses' });
  Expense.belongsTo(ExpenseReport, { foreignKey: 'report_id', as: 'report' });
  Expense.belongsTo(ExpenseCategory, { foreignKey: 'category_id', as: 'category' });
  ExpenseReport.hasMany(ExpenseApproval, { foreignKey: 'report_id', as: 'approvals' });
  ExpenseReport.hasMany(ExpenseComment, { foreignKey: 'report_id', as: 'comments' });
  ExpenseReport.hasMany(ExpenseActivity, { foreignKey: 'report_id', as: 'activities' });

  ctx = {
    ExpenseReport,
    Expense,
    ExpenseCategory,
    ExpenseApproval,
    ExpenseComment,
    ExpenseActivity,
    sequelize: s,
  };
  return ctx;
}
