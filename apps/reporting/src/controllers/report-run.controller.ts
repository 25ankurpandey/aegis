import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpDelete, httpGet, httpPatch, httpPost } from 'inversify-express-utils';
import { routeParam, validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { ReportingShape } from '@aegis/shared-types';
import { authenticate, authorize } from '@aegis/access-control';
import { ReportingService } from '../services/reporting.service';
import {
  createRunSchema,
  createScheduleSchema,
  idParamSchema,
  listRunsQuerySchema,
  listSchedulesQuerySchema,
  updateScheduleSchema,
} from '../validators/report-run.validator';

/**
 * Report-run surface (the asynchronous run lifecycle). Every route is PEP-guarded
 * (authenticate → authorize(permission)). Runs are asynchronous: POST returns 202 + { runId } with a
 * Location header; the client polls GET /report-runs/:id for status + artifact_url. Request bodies
 * validate via the `validate(...)` middleware.
 */
@controller(`/reporting${ApiConstants.PublicPrefix}`)
export class ReportRunController {
  constructor(@inject(ReportingService) private readonly reporting: ReportingService) {}

  @httpPost('/report-runs', authenticate(), authorize(Permission.ReportRun), validate(createRunSchema))
  async createRun(req: Request, res: Response): Promise<void> {
    const result = await this.reporting.createRun(req.body);
    res.status(202).location(`/reporting${ApiConstants.PublicPrefix}/report-runs/${result.runId}`);
    res.json({ data: result });
  }

  @httpGet(
    '/report-runs',
    authenticate(),
    authorize(Permission.ReportView),
    validate(listRunsQuerySchema, 'query'),
  )
  async listRuns(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.reporting.listRuns(req.query as unknown as ReportingShape.ListRunsInput));
  }

  @httpGet(
    '/report-runs/:id',
    authenticate(),
    authorize(Permission.ReportView),
    validate(idParamSchema, 'params'),
  )
  async getRun(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.reporting.getRun(routeParam(req, 'id')) });
  }

  @httpGet(
    '/report-runs/:id/export',
    authenticate(),
    authorize(Permission.ReportView),
    validate(idParamSchema, 'params'),
  )
  async getRunExport(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.reporting.getRunExport(routeParam(req, 'id')) });
  }

  @httpPost(
    '/report-schedules',
    authenticate(),
    authorize(Permission.ReportDefine),
    validate(createScheduleSchema),
  )
  async createSchedule(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.reporting.createSchedule(req.body) });
  }

  @httpGet(
    '/report-schedules',
    authenticate(),
    authorize(Permission.ReportView),
    validate(listSchedulesQuerySchema, 'query'),
  )
  async listSchedules(req: Request, res: Response): Promise<void> {
    res
      .status(200)
      .json(await this.reporting.listSchedules(req.query as unknown as ReportingShape.ListSchedulesInput));
  }

  @httpPatch(
    '/report-schedules/:id',
    authenticate(),
    authorize(Permission.ReportDefine),
    validate(idParamSchema, 'params'),
    validate(updateScheduleSchema),
  )
  async updateSchedule(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.reporting.updateSchedule(routeParam(req, 'id'), req.body) });
  }

  @httpDelete(
    '/report-schedules/:id',
    authenticate(),
    authorize(Permission.ReportDefine),
    validate(idParamSchema, 'params'),
  )
  async deleteSchedule(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.reporting.deleteSchedule(routeParam(req, 'id')) });
  }
}
