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
import { Permission, InvoiceStatus } from '@aegis/shared-enums';
import { ApiConstants, PaginationConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { RecordAnnotationFeatureFlag } from '@aegis/db';
import { InvoiceService } from '../services/invoice.service';
import {
  createInvoiceSchema,
  approveInvoiceSchema,
  decideInvoiceSchema,
} from '../validators/invoice.validator';

/**
 * Invoice HTTP surface — every route is PEP-guarded (authenticate → authorize(permission)); request
 * bodies validate via the `validate(...)` middleware in the route decorators.
 */
@controller(`/invoice${ApiConstants.PublicPrefix}`)
export class InvoiceController {
  constructor(@inject(InvoiceService) private readonly invoices: InvoiceService) {}

  @httpPost(
    '/invoices',
    authenticate(),
    authorize(Permission.InvoiceCreate),
    validate(createInvoiceSchema),
  )
  async create(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.invoices.create(req.body) });
  }

  @httpGet('/invoices', authenticate(), authorize(Permission.InvoiceView))
  async list(req: Request, res: Response): Promise<void> {
    const page = Math.max(1, Number(req.query['page']) || PaginationConstants.DefaultPage);
    const pageSize = Math.min(
      PaginationConstants.MaxPageSize,
      Number(req.query['pageSize']) || PaginationConstants.DefaultPageSize,
    );
    const status = req.query['status'] as InvoiceStatus | undefined;
    const vendorId = req.query['vendorId'] as string | undefined;
    const filters = parseRecordAnnotationQuery(req.query, RequestContext.userId());
    if (
      hasRecordAnnotationScopeFilters(filters) &&
      !(await FeatureFlags.isEnabled(RecordAnnotationFeatureFlag))
    ) {
      throw ErrUtils.forbidden(`Feature flag '${RecordAnnotationFeatureFlag}' is disabled`);
    }
    res
      .status(200)
      .json(await this.invoices.list({ status, vendorId, ...filters }, page, pageSize));
  }

  /**
   * The current user's pending invoice approval slots: GET /invoices/approvals/pending. Guarded by
   * the `approve` permission (only principals who can approve have an inbox). Registered BEFORE the
   * generic `/invoices/:id` GET so the literal path is not captured by the `:id` param.
   */
  @httpGet('/invoices/approvals/pending', authenticate(), authorize(Permission.InvoiceApprove))
  async listPendingApprovals(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.invoices.listPendingApprovals() });
  }

  @httpGet('/invoices/:id', authenticate(), authorize(Permission.InvoiceView))
  async getOne(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.invoices.getById(routeParam(req, 'id')) });
  }

  @httpPost('/invoices/:id/submit', authenticate(), authorize(Permission.InvoiceUpdate))
  async submit(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.invoices.submit(routeParam(req, 'id')) });
  }

  /**
   * Record an approval decision through the shared engine: POST /invoices/:id/decisions
   * `{ decision: approved|rejected, comment? }`. Guarded by the invoice `approve` permission. The
   * engine records the vote + advances the chain; on completion the invoice advances
   * (approved→Approved + ERP outbox push, rejected→Rejected). The canonical engine-backed decision
   * surface; `/approve` is kept as a thin backward-compatible alias.
   */
  @httpPost(
    '/invoices/:id/decisions',
    authenticate(),
    authorize(Permission.InvoiceApprove),
    validate(decideInvoiceSchema),
  )
  async decide(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.invoices.decide(routeParam(req, 'id'), req.body) });
  }

  /**
   * Approve an invoice (engine-backed). Backward-compatible alias for
   * `POST /invoices/:id/decisions { decision: 'approved' }`.
   */
  @httpPost(
    '/invoices/:id/approve',
    authenticate(),
    authorize(Permission.InvoiceApprove),
    validate(approveInvoiceSchema),
  )
  async approve(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.invoices.approve(routeParam(req, 'id'), req.body) });
  }
}
