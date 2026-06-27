import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants, PaginationConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { ReportingService } from '../services/reporting.service';
import { createDefinitionSchema } from '../validators/report-definition.validator';

/**
 * Report-definition surface (the declarative write side + paged read). Every route is PEP-guarded
 * (authenticate → authorize(permission)); tenantId/userId come from the validated request context,
 * never the body. Request bodies validate via the `validate(...)` middleware.
 */
@controller(`/reporting${ApiConstants.PublicPrefix}`)
export class ReportDefinitionController {
  constructor(@inject(ReportingService) private readonly reporting: ReportingService) {}

  @httpPost('/report-definitions', authenticate(), authorize(Permission.ReportDefine), validate(createDefinitionSchema))
  async createDefinition(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.reporting.createDefinition(req.body) });
  }

  @httpGet('/report-definitions', authenticate(), authorize(Permission.ReportView))
  async listDefinitions(req: Request, res: Response): Promise<void> {
    const page = Math.max(1, Number(req.query['page']) || PaginationConstants.DefaultPage);
    const pageSize = Math.min(
      PaginationConstants.MaxPageSize,
      Math.max(1, Number(req.query['pageSize']) || PaginationConstants.DefaultPageSize),
    );
    res.status(200).json(await this.reporting.listDefinitions({ page, pageSize }));
  }
}
