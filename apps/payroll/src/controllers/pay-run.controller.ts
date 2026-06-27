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
import { PayrollShape } from '@aegis/shared-types';
import { authenticate, authorize, authorizeAny } from '@aegis/access-control';
import { RecordAnnotationFeatureFlag } from '@aegis/db';
import { PayRunService } from '../services/pay-run.service';
import {
  approveSchema,
  createPayRunSchema,
  decideSchema,
  payRunIdParamSchema,
  payslipListQuerySchema,
} from '../validators/pay-run.validator';

/** Pay-run lifecycle HTTP surface — every route is PEP-guarded with a granular permission. */
@controller(`/payroll${ApiConstants.PublicPrefix}`)
export class PayRunController {
  constructor(@inject(PayRunService) private readonly payRuns: PayRunService) {}

  @httpGet('/pay-runs', authenticate(), authorize(Permission.PayRunApprove))
  async list(req: Request, res: Response): Promise<void> {
    const page = Math.max(1, Number(req.query['page']) || PaginationConstants.DefaultPage);
    const pageSize = Math.min(
      PaginationConstants.MaxPageSize,
      Number(req.query['pageSize']) || PaginationConstants.DefaultPageSize,
    );
    const filters = parseRecordAnnotationQuery(req.query, RequestContext.userId());
    if (
      hasRecordAnnotationScopeFilters(filters) &&
      !(await FeatureFlags.isEnabled(RecordAnnotationFeatureFlag))
    ) {
      throw ErrUtils.forbidden(`Feature flag '${RecordAnnotationFeatureFlag}' is disabled`);
    }
    res.status(200).json(await this.payRuns.list(filters, page, pageSize));
  }

  @httpPost(
    '/pay-runs',
    authenticate(),
    authorize(Permission.PayRunCreate),
    validate(createPayRunSchema),
  )
  async create(req: Request, res: Response): Promise<void> {
    res.status(201).json(await this.payRuns.create(req.body));
  }

  @httpPost('/pay-runs/:id/calculate', authenticate(), authorize(Permission.PayRunCalculate))
  async calculate(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.payRuns.calculate(routeParam(req, 'id')));
  }

  /**
   * Record an approval decision through the shared engine: POST /pay-runs/:id/decisions
   * `{ decision: approved|rejected, comment? }`. Guarded by the `PayRunApprove` permission. The engine
   * records the vote + advances the chain; on completion the run advances (approved → Approved + the
   * PayRunApproved event; rejected leaves the run Calculated). The canonical engine-backed decision
   * surface (the template expense/invoice copy); `/approve` is kept as a thin alias.
   */
  @httpPost(
    '/pay-runs/:id/decisions',
    authenticate(),
    authorize(Permission.PayRunApprove),
    validate(decideSchema),
  )
  async decide(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.payRuns.decide(routeParam(req, 'id'), req.body));
  }

  /**
   * The current user's pending pay-run approval slots: GET /pay-runs/approvals/pending. Guarded by the
   * `PayRunApprove` permission (only principals who can approve have an inbox). Registered before any
   * generic `/pay-runs/:id` route so the literal path is not captured by the `:id` param.
   */
  @httpGet('/pay-runs/approvals/pending', authenticate(), authorize(Permission.PayRunApprove))
  async listPendingApprovals(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.payRuns.listPendingApprovals() });
  }

  @httpGet(
    '/pay-runs/:id/payslips',
    authenticate(),
    authorizeAny([Permission.PayslipViewAll, Permission.PayslipViewOwn]),
    validate(payRunIdParamSchema, 'params'),
    validate(payslipListQuerySchema, 'query'),
  )
  async listPayslipsForRun(req: Request, res: Response): Promise<void> {
    const { page, pageSize } = this.page(req);
    const filter = req.query as unknown as PayrollShape.PayslipListFilter;
    res
      .status(200)
      .json(
        await this.payRuns.listPayslips(
          { ...filter, payRunId: routeParam(req, 'id') },
          page,
          pageSize,
          this.payslipAccess(res),
        ),
      );
  }

  @httpGet(
    '/payslips',
    authenticate(),
    authorizeAny([Permission.PayslipViewAll, Permission.PayslipViewOwn]),
    validate(payslipListQuerySchema, 'query'),
  )
  async listPayslips(req: Request, res: Response): Promise<void> {
    const { page, pageSize } = this.page(req);
    res
      .status(200)
      .json(
        await this.payRuns.listPayslips(
          req.query as unknown as PayrollShape.PayslipListFilter,
          page,
          pageSize,
          this.payslipAccess(res),
        ),
      );
  }

  @httpGet(
    '/payslips/:id',
    authenticate(),
    authorizeAny([Permission.PayslipViewAll, Permission.PayslipViewOwn]),
    validate(payRunIdParamSchema, 'params'),
  )
  async getPayslip(req: Request, res: Response): Promise<void> {
    res
      .status(200)
      .json({ data: await this.payRuns.getPayslip(routeParam(req, 'id'), this.payslipAccess(res)) });
  }

  @httpGet(
    '/pay-runs/:id',
    authenticate(),
    authorize(Permission.PayRunApprove),
    validate(payRunIdParamSchema, 'params'),
  )
  async get(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.payRuns.get(routeParam(req, 'id')) });
  }

  /**
   * Approve a run: Calculated → Approved (engine-backed). Backward-compatible alias for
   * `POST /pay-runs/:id/decisions { decision: 'approved' }`. The inline single-shot approve is GONE.
   */
  @httpPost(
    '/pay-runs/:id/approve',
    authenticate(),
    authorize(Permission.PayRunApprove),
    validate(approveSchema),
  )
  async approve(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.payRuns.approve(routeParam(req, 'id'), req.body?.comment));
  }

  @httpPost('/pay-runs/:id/disburse', authenticate(), authorize(Permission.PayRunDisburse))
  async disburse(req: Request, res: Response): Promise<void> {
    const idempotencyKey = (req.header('Idempotency-Key') ?? '').trim();
    res.status(200).json(await this.payRuns.disburse(routeParam(req, 'id'), idempotencyKey));
  }

  private page(req: Request): { page: number; pageSize: number } {
    const page = Math.max(1, Number(req.query['page']) || PaginationConstants.DefaultPage);
    const pageSize = Math.min(
      PaginationConstants.MaxPageSize,
      Number(req.query['pageSize']) || PaginationConstants.DefaultPageSize,
    );
    return { page, pageSize };
  }

  private payslipAccess(res: Response): { canViewAll: boolean } {
    return { canViewAll: res.locals.authorizedPermission === Permission.PayslipViewAll };
  }
}
