import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpDelete, httpGet, httpPatch, httpPost } from 'inversify-express-utils';
import { routeParam, validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { ReportingShape, type AccessShape } from '@aegis/shared-types';
import { authenticate, authorize } from '@aegis/access-control';
import { withTenantTransaction } from '@aegis/db';
import { ReportingService } from '../services/reporting.service';
import { ReportRunRepository } from '../repositories/report-run.repository';
import { ReportScheduleRepository } from '../repositories/report-schedule.repository';
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
    authorize(Permission.ReportView, { resource: (req) => loadRunResource(req) }),
    validate(idParamSchema, 'params'),
  )
  async getRun(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.reporting.getRun(routeParam(req, 'id')) });
  }

  @httpGet(
    '/report-runs/:id/export',
    authenticate(),
    authorize(Permission.ReportView, { resource: (req) => loadRunResource(req) }),
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
    authorize(Permission.ReportDefine, { resource: (req) => loadScheduleResource(req) }),
    validate(idParamSchema, 'params'),
    validate(updateScheduleSchema),
  )
  async updateSchedule(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.reporting.updateSchedule(routeParam(req, 'id'), req.body) });
  }

  @httpDelete(
    '/report-schedules/:id',
    authenticate(),
    authorize(Permission.ReportDefine, { resource: (req) => loadScheduleResource(req) }),
    validate(idParamSchema, 'params'),
  )
  async deleteSchedule(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.reporting.deleteSchedule(routeParam(req, 'id')) });
  }
}

/**
 * Row-scope loaders (closing the T27 audit gaps on reporting). A report run is owned by its
 * `requested_by`; a schedule by its `created_by`. checkRowScope then denies an own_only principal a
 * peer's run/schedule (and own_and_team fail-closes to owner-only here — no team column). An
 * RLS-invisible id yields an undefined owner → the standard 404.
 */
async function loadRunResource(req: Request): Promise<AccessShape.ResourceRef> {
  const id = routeParam(req, 'id');
  const repo = new ReportRunRepository();
  const run = await withTenantTransaction((t) => repo.findById(id, t));
  return { type: 'report_run', id, ownerId: run?.requested_by ?? undefined };
}

async function loadScheduleResource(req: Request): Promise<AccessShape.ResourceRef> {
  const id = routeParam(req, 'id');
  const repo = new ReportScheduleRepository();
  const schedule = await withTenantTransaction((t) => repo.findById(id, t));
  return { type: 'report_schedule', id, ownerId: schedule?.created_by ?? undefined };
}
