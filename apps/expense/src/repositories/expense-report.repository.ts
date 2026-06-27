import type { Transaction } from 'sequelize';
import { ErrUtils } from '@aegis/service-core';
import { ApprovalRecordType, TableName } from '@aegis/shared-enums';
import { ExpenseShape } from '@aegis/shared-types';
import { withRecordAnnotationListFilters } from '@aegis/db';
import { provideSingleton } from '../ioc/container';
import { getExpenseContext } from '../models/database-context';

/**
 * Data access for the expense-report aggregate (`expense_reports` + its child decisions/comments/
 * activities, and the denormalized total computed from attached `expenses`). Every method takes the
 * RLS-scoped `Transaction` opened by the SERVICE via `withTenantTransaction`, so `app.current_tenant`
 * is always set when these run.
 */
@provideSingleton(ExpenseReportRepository)
export class ExpenseReportRepository {
  // ---- reports ----

  /** Next per-tenant sequential report number (max+1 within the RLS-scoped tenant). */
  async nextReportNumber(t: Transaction): Promise<number> {
    const { ExpenseReport } = getExpenseContext();
    const max = (await ExpenseReport.max('report_number', { transaction: t })) as number | null;
    return (max ?? 0) + 1;
  }

  async createReport(
    data: ExpenseShape.CreateReportRow,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseReportRow> {
    const { ExpenseReport } = getExpenseContext();
    const row = await ExpenseReport.create({ ...data, total_amount: 0 }, { transaction: t });
    return row.get({ plain: true }) as ExpenseShape.ExpenseReportRow;
  }

  async findReportById(id: string, t: Transaction): Promise<ExpenseShape.ExpenseReportRow | null> {
    const { ExpenseReport } = getExpenseContext();
    const row = await ExpenseReport.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as ExpenseShape.ExpenseReportRow) : null;
  }

  async listReports(
    opts: ExpenseShape.ListReportsOptions,
    t: Transaction,
  ): Promise<{ rows: ExpenseShape.ExpenseReportRow[]; total: number }> {
    const { ExpenseReport } = getExpenseContext();
    const filter = withRecordAnnotationListFilters(
      opts.submitterId ? { submitter_id: opts.submitterId } : {},
      opts,
      {
        tableName: TableName.ExpenseReports,
        recordType: ApprovalRecordType.ExpenseReport,
        sequelize: getExpenseContext().sequelize,
      },
    );
    const { rows, count } = await ExpenseReport.findAndCountAll({
      where: filter,
      order: [['report_number', 'DESC']],
      limit: opts.limit,
      offset: opts.offset,
      transaction: t,
    });
    return {
      rows: rows.map((r) => r.get({ plain: true }) as ExpenseShape.ExpenseReportRow),
      total: count,
    };
  }

  async updateReport(
    id: string,
    patch: ExpenseShape.UpdateReportRow,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseReportRow | null> {
    const { ExpenseReport } = getExpenseContext();
    const row = await ExpenseReport.findByPk(id, { transaction: t });
    if (!row) return null;
    await row.update(patch, { transaction: t });
    return row.get({ plain: true }) as ExpenseShape.ExpenseReportRow;
  }

  /**
   * Persist the workflow-rule annotations (`team_id` / `tags`). Used by the RecordUpdated consumer to
   * apply an `assign_team` / `add_tag` action to the record it owns; the service computes the merged
   * values (team set, tags unioned) and passes only the changed fields. Atomic within the RLS tx.
   */
  async applyLabels(
    id: string,
    patch: { team_id?: string | null; assignee_id?: string | null; tags?: string[] | null },
    t: Transaction,
  ): Promise<void> {
    const { ExpenseReport } = getExpenseContext();
    const row = await ExpenseReport.findByPk(id, { transaction: t });
    if (!row) return;
    await row.update(patch, { transaction: t });
  }

  /**
   * Recompute and persist a report's denormalized total from its attached expenses.
   *
   * The total is a single-currency BIGINT minor-units sum, so a plain `SUM(amount)` across lines is
   * only meaningful when every attached item shares one currency. The service guards currency at
   * attach time; this is the defensive last line: if a report's items ever span more than one
   * currency we refuse to compute a meaningless total (which would otherwise be pushed to the ERP)
   * and throw a validation error instead of silently mis-summing.
   */
  async recomputeReportTotal(reportId: string, t: Transaction): Promise<number> {
    const { Expense } = getExpenseContext();
    const grouped = await Expense.findAll({
      attributes: ['currency'],
      where: { report_id: reportId },
      group: ['currency'],
      raw: true,
      transaction: t,
    });
    const distinct = (grouped as unknown as Array<{ currency: string | null }>)
      .map((g) => g.currency)
      .filter((c): c is string => c != null);
    if (distinct.length > 1) {
      throw ErrUtils.validation(`Cannot total a report mixing currencies (${distinct.join(', ')})`);
    }
    const sum = (await Expense.sum('amount', {
      where: { report_id: reportId },
      transaction: t,
    })) as number | null;
    const total = sum ?? 0;
    await this.updateReport(reportId, { total_amount: total }, t);
    return total;
  }

  // ---- approvals ----

  async createApproval(
    data: ExpenseShape.CreateApprovalRow,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseApprovalRow> {
    const { ExpenseApproval } = getExpenseContext();
    const row = await ExpenseApproval.create(
      { ...data, decided_at: new Date() },
      { transaction: t },
    );
    return row.get({ plain: true }) as ExpenseShape.ExpenseApprovalRow;
  }

  /** The approval chain for a report, oldest decision first (chronological). */
  async listApprovalsForReport(
    reportId: string,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseApprovalRow[]> {
    const { ExpenseApproval } = getExpenseContext();
    const rows = await ExpenseApproval.findAll({
      where: { report_id: reportId },
      order: [
        ['level', 'ASC'],
        ['decided_at', 'ASC'],
      ],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as ExpenseShape.ExpenseApprovalRow);
  }

  // ---- comments ----

  async createComment(
    data: ExpenseShape.CreateCommentRow,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseCommentRow> {
    const { ExpenseComment } = getExpenseContext();
    const row = await ExpenseComment.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ExpenseShape.ExpenseCommentRow;
  }

  /** All comments on a report, oldest first (thread order). */
  async listCommentsForReport(
    reportId: string,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseCommentRow[]> {
    const { ExpenseComment } = getExpenseContext();
    const rows = await ExpenseComment.findAll({
      where: { report_id: reportId },
      order: [['created_at', 'ASC']],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as ExpenseShape.ExpenseCommentRow);
  }

  // ---- activities (append-only audit feed) ----

  async createActivity(
    data: ExpenseShape.CreateActivityRow,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseActivityRow> {
    const { ExpenseActivity } = getExpenseContext();
    const row = await ExpenseActivity.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ExpenseShape.ExpenseActivityRow;
  }

  /** The activity timeline for a report, oldest first (append-only feed order). */
  async listActivitiesForReport(
    reportId: string,
    t: Transaction,
  ): Promise<ExpenseShape.ExpenseActivityRow[]> {
    const { ExpenseActivity } = getExpenseContext();
    const rows = await ExpenseActivity.findAll({
      where: { report_id: reportId },
      order: [['created_at', 'ASC']],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as ExpenseShape.ExpenseActivityRow);
  }
}
