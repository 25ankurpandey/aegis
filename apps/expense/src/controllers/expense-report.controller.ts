import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import {
  ErrUtils,
  FeatureFlags,
  RequestContext,
  hasRecordAnnotationScopeFilters,
  parseRecordAnnotationQuery,
  routeParam,
  validate,
} from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants, PaginationConstants } from '@aegis/shared-constants';
import { authenticate, authorize, amountCapPolicies } from '@aegis/access-control';
import type { AccessShape } from '@aegis/shared-types';
import { RecordAnnotationFeatureFlag, withTenantTransaction } from '@aegis/db';
import { ExpenseService } from '../services/expense.service';
import { ExpenseReportRepository } from '../repositories/expense-report.repository';
import {
  createReportSchema,
  attachExpenseSchema,
  submitSchema,
  approveSchema,
  rejectSchema,
  reimburseSchema,
  addCommentSchema,
  recallSchema,
  decideSchema,
} from '../validators/expense-report.validator';

/**
 * Expense-report HTTP surface. Every route is PEP-guarded (authenticate → authorize(permission) →
 * handler) and request bodies validate via the `validate(...)` middleware. State transitions are POST
 * action sub-resources, one permission each. Tenant is ambient (RLS) — there is no tenant path
 * segment. Lists return the `{ data, meta }` shape.
 */
@controller(`/expense${ApiConstants.PublicPrefix}`)
export class ExpenseReportController {
  constructor(@inject(ExpenseService) private readonly expense: ExpenseService) {}

  /** Create an expense report (OPEN). */
  @httpPost(
    '/reports',
    authenticate(),
    authorize(Permission.ExpenseReportCreate),
    validate(createReportSchema),
  )
  async createReport(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.expense.createReport(req.body) });
  }

  /** Attach an expense item to a report (OPEN, submitter only). */
  @httpPost(
    '/reports/:id/expenses',
    authenticate(),
    authorize(Permission.ExpenseReportUpdate, { resource: (req) => loadReportResource(req) }),
    validate(attachExpenseSchema),
  )
  async attachExpense(req: Request, res: Response): Promise<void> {
    res
      .status(200)
      .json({ data: await this.expense.attachExpenseToReport(routeParam(req, 'id'), req.body) });
  }

  /** Submit a report: OPEN → APPROVALS. Emits expense.submitted. */
  @httpPost(
    '/reports/:id/submit',
    authenticate(),
    authorize(Permission.ExpenseReportSubmit, { resource: (req) => loadReportResource(req) }),
    validate(submitSchema),
  )
  async submit(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.submitReport(routeParam(req, 'id')) });
  }

  /**
   * Record an approval decision through the shared engine: POST /reports/:id/decisions
   * `{ decision: approved|rejected, comment? }`. Guarded by the expense `approve` permission. The
   * engine records the vote + advances the chain; on completion the report advances
   * (approved→APPROVED + ERP push, rejected→REJECTED). The canonical engine-backed decision surface
   * (the template invoice/payroll copy); `/approve` is kept as a thin alias for backward compat.
   */
  @httpPost(
    '/reports/:id/decisions',
    authenticate(),
    authorize(Permission.ExpenseReportApprove, {
      resource: (req) => loadReportResource(req),
      // W5-04 ABAC: deny an over-cap approval even though RBAC granted `approve` (amount-cap example
      // "an approver may approve up to $X"). The cap is the approver's `approvalLimit` attribute.
      policies: amountCapPolicies(Permission.ExpenseReportApprove),
    }),
    validate(decideSchema),
  )
  async decide(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.decideReport(routeParam(req, 'id'), req.body) });
  }

  /**
   * The current user's pending expense-report approval slots: GET /reports/approvals/pending.
   * Guarded by the `approve` permission (only principals who can approve have an inbox). Registered
   * before the generic `/reports/:id` GET so the literal path is not captured by the `:id` param.
   */
  @httpGet('/reports/approvals/pending', authenticate(), authorize(Permission.ExpenseReportApprove))
  async listPendingApprovals(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.listPendingApprovals() });
  }

  /**
   * Approve a report: APPROVALS → APPROVED (engine-backed). Backward-compatible alias for
   * `POST /reports/:id/decisions { decision: 'approved' }`.
   */
  @httpPost(
    '/reports/:id/approve',
    authenticate(),
    authorize(Permission.ExpenseReportApprove, {
      resource: (req) => loadReportResource(req),
      // W5-04 ABAC amount-cap (same gate as /decisions; this is its backward-compat alias).
      policies: amountCapPolicies(Permission.ExpenseReportApprove),
    }),
    validate(approveSchema),
  )
  async approve(req: Request, res: Response): Promise<void> {
    res.status(200).json({
      data: await this.expense.decideReport(routeParam(req, 'id'), {
        decision: 'approved',
        comment: req.body?.comment,
      }),
    });
  }

  /** Reject a report: APPROVALS → REJECTED. Emits expense.rejected. */
  @httpPost(
    '/reports/:id/reject',
    authenticate(),
    authorize(Permission.ExpenseReportReject, { resource: (req) => loadReportResource(req) }),
    validate(rejectSchema),
  )
  async reject(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.rejectReport(routeParam(req, 'id'), req.body) });
  }

  /** Reimburse a report: APPROVED → REIMBURSED. Finance/admin only. */
  @httpPost(
    '/reports/:id/reimburse',
    authenticate(),
    authorize(Permission.ExpenseReportReimburse, { resource: (req) => loadReportResource(req) }),
    validate(reimburseSchema),
  )
  async reimburse(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.reimburseReport(routeParam(req, 'id'), req.body) });
  }

  /**
   * Recall a still-pending report: APPROVALS → OPEN (submitter/admin). Rejected if already
   * APPROVED/REIMBURSED. Reuses the submit permission (the submitter's own lifecycle action).
   */
  @httpPost(
    '/reports/:id/recall',
    authenticate(),
    authorize(Permission.ExpenseReportSubmit, { resource: (req) => loadReportResource(req) }),
    validate(recallSchema),
  )
  async recall(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.recallReport(routeParam(req, 'id'), req.body) });
  }

  /** Add a comment to a report's discussion thread. Guarded by the view permission. */
  @httpPost(
    '/reports/:id/comments',
    authenticate(),
    authorize(Permission.ExpenseReportView, { resource: (req) => loadReportResource(req) }),
    validate(addCommentSchema),
  )
  async addComment(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.expense.addComment(routeParam(req, 'id'), req.body) });
  }

  /** List a report's comment thread (oldest first). Guarded by the view permission. */
  @httpGet(
    '/reports/:id/comments',
    authenticate(),
    authorize(Permission.ExpenseReportView, { resource: (req) => loadReportResource(req) }),
  )
  async listComments(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.listComments(routeParam(req, 'id')) });
  }

  /**
   * Full report detail (header + line expenses + approvals + comments + activity timeline) in one
   * tenant-scoped call. Guarded by the same view permission as the single-report GET.
   */
  @httpGet(
    '/reports/:id/detail',
    authenticate(),
    authorize(Permission.ExpenseReportView, { resource: (req) => loadReportResource(req) }),
  )
  async getReportDetail(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.getReportDetail(routeParam(req, 'id')) });
  }

  /** List reports (row-scoped, paged). */
  @httpGet('/reports', authenticate(), authorize(Permission.ExpenseReportView))
  async listReports(req: Request, res: Response): Promise<void> {
    const page = clampInt(
      req.query['page'],
      PaginationConstants.DefaultPage,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const pageSize = clampInt(
      req.query['pageSize'],
      PaginationConstants.DefaultPageSize,
      1,
      PaginationConstants.MaxPageSize,
    );
    const filters = parseRecordAnnotationQuery(req.query, RequestContext.userId());
    if (
      hasRecordAnnotationScopeFilters(filters) &&
      !(await FeatureFlags.isEnabled(RecordAnnotationFeatureFlag))
    ) {
      throw ErrUtils.forbidden(`Feature flag '${RecordAnnotationFeatureFlag}' is disabled`);
    }
    res.status(200).json(await this.expense.listReports({ page, pageSize, ...filters }));
  }

  /** Get a single report by id (404 if RLS-invisible). */
  @httpGet(
    '/reports/:id',
    authenticate(),
    authorize(Permission.ExpenseReportView, { resource: (req) => loadReportResource(req) }),
  )
  async getReport(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.expense.getReport(routeParam(req, 'id')) });
  }
}

/**
 * Resource loader for the PEP: fetch the target report (under RLS) so the PDP has its ABAC
 * attributes (owner, status, amount). Returns an empty ref if the row is RLS-invisible — the
 * service-layer load then yields the standard 404.
 */
async function loadReportResource(req: Request): Promise<AccessShape.ResourceRef> {
  const id = routeParam(req, 'id');
  const repo = new ExpenseReportRepository();
  const report = await withTenantTransaction((t) => repo.findReportById(id, t));
  return {
    type: 'expense_report',
    id,
    ownerId: report?.submitter_id,
    attributes: report ? { status: report.status, amount: Number(report.total_amount) } : {},
  };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
