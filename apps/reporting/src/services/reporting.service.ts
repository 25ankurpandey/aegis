import { inject } from 'inversify';
import { ErrUtils, RequestContext } from '@aegis/service-core';
import { Permission, ReportRunStatus } from '@aegis/shared-enums';
import { ReportingShape } from '@aegis/shared-types';
import { withTenantTransaction } from '@aegis/db';
import { ActivityLogger } from '@aegis/activity';
import type { Transaction } from 'sequelize';
import { provideSingleton } from '../ioc/container';
import { ReportDefinitionRepository } from '../repositories/report-definition.repository';
import { ReportRunRepository } from '../repositories/report-run.repository';
import { ReportScheduleRepository } from '../repositories/report-schedule.repository';

/**
 * Reporting application service (CQRS-lite read side). It owns the declarative report definitions,
 * the per-tenant access policies, and the asynchronous run lifecycle. Every data path runs inside
 * withTenantTransaction so the tenant RLS predicate is set first — RLS is never bypassed here. The
 * service owns the transaction; the repositories take it.
 *
 * In production a run is enqueued to a BullMQ worker that compiles the definition against the read
 * model (facts/MVs), applies column masking + the row filter, renders the artifact, and flips the
 * run to 'succeeded'. For the demo a run is marked 'succeeded' synchronously with a stub artifact.
 */
@provideSingleton(ReportingService)
export class ReportingService {
  constructor(
    @inject(ReportDefinitionRepository) private readonly definitions: ReportDefinitionRepository,
    @inject(ReportRunRepository) private readonly runs: ReportRunRepository,
    @inject(ReportScheduleRepository) private readonly schedules: ReportScheduleRepository,
  ) {}

  /** Create a declarative definition. The spec is data, never raw SQL (compiled later). */
  async createDefinition(
    input: ReportingShape.CreateDefinitionInput,
  ): Promise<ReportingShape.ReportDefinitionRow> {
    const tenantId = RequestContext.tenantId();
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');
    return withTenantTransaction((t) =>
      this.definitions.create(
        {
          tenant_id: tenantId,
          name: input.name,
          spec: input.spec,
          // default the gate to the run permission unless the author pins a stricter one
          required_permission: input.requiredPermission ?? Permission.ReportRun,
          created_by: userId,
        },
        t,
      ),
    );
  }

  /** Paged list of tenant-scoped definitions. */
  async listDefinitions(
    input: ReportingShape.ListDefinitionsInput,
  ): Promise<ReportingShape.ListDefinitionsResult> {
    const { page, pageSize } = input;
    return withTenantTransaction(async (t) => {
      const { rows, total } = await this.definitions.list(
        { limit: pageSize, offset: (page - 1) * pageSize },
        t,
      );
      return { data: rows, meta: { total, page, pageSize } };
    });
  }

  /**
   * Enqueue a report run. Inserts a report_run as 'queued' and returns 202 + runId. For the demo we
   * then synchronously settle it to 'succeeded' with a stub artifact_url; the documented production
   * path hands the runId to a BullMQ worker instead. The run result respects the caller role's
   * report_access_policies.masked_columns — masking is applied in the compiler BEFORE SQL is built,
   * so sensitive payroll columns never enter the query plan, cache, or artifact (§5.2).
   */
  async createRun(input: ReportingShape.CreateRunInput): Promise<ReportingShape.CreateRunResult> {
    const tenantId = RequestContext.tenantId();
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');

    return withTenantTransaction(async (t) => {
      const definition = await this.definitions.findById(input.definitionId, t);
      if (!definition) throw ErrUtils.notFound('Report definition not found');

      // Resolve the caller's column-masking policy (drives what the run may project). The masking
      // obligation is conceptual in the demo, but we load the policy here to prove the wiring.
      const role = RequestContext.roles()[0];
      if (role) {
        await this.runs.findAccessPolicyByRole(role, t);
      }

      const run = await this.runs.create(
        {
          tenant_id: tenantId,
          definition_id: definition.id,
          requested_by: userId,
          params: input.params ?? {},
          status: ReportRunStatus.Queued,
        },
        t,
      );

      // W5-13 — a report run was REQUESTED: append to the SHARED business timeline (same RLS tx).
      await this.writeActivity(
        run.id,
        userId,
        'run_requested',
        {
          definitionId: definition.id,
          definitionName: definition.name,
          status: ReportRunStatus.Queued,
        },
        t,
      );

      // Demo: settle synchronously. Production enqueues to BullMQ; the worker does this update.
      const settled = await this.runs.update(
        run.id,
        {
          status: ReportRunStatus.Succeeded,
          started_at: new Date(),
          finished_at: new Date(),
          artifact_url: this.stubArtifactUrl(run.id),
        },
        t,
      );

      // W5-13 — the run COMPLETED (demo settles synchronously; the BullMQ worker would emit this on
      // the async path). Same RLS tx so the requested→completed pair is atomic with the run write.
      await this.writeActivity(
        run.id,
        userId,
        'run_completed',
        { definitionId: definition.id, status: settled?.status ?? run.status },
        t,
      );

      return { runId: run.id, status: settled?.status ?? run.status };
    });
  }

  /** Paged list of tenant-scoped report runs, optionally narrowed by definition/status. */
  async listRuns(input: ReportingShape.ListRunsInput): Promise<ReportingShape.ListRunsResult> {
    const { page, pageSize } = input;
    return withTenantTransaction(async (t) => {
      const { rows, total } = await this.runs.list(
        {
          limit: pageSize,
          offset: (page - 1) * pageSize,
          definitionId: input.definitionId,
          status: input.status,
        },
        t,
      );
      return { data: rows.map((r) => this.toRunDto(r)), meta: { total, page, pageSize } };
    });
  }

  /**
   * Append to the SHARED, polymorphic business timeline (@aegis/activity), keyed by `(report_run,
   * runId)` — the cross-service who-did-what feed (the reusable pattern expense/invoice/payroll copy).
   * Always called inside the active RLS-scoped tx so tenant scoping holds on write.
   */
  private async writeActivity(
    runId: string,
    actorId: string | null,
    action: string,
    details: Record<string, unknown>,
    t: Transaction,
  ): Promise<void> {
    await ActivityLogger.record(
      { recordType: 'report_run', recordId: runId, action, actorId, details },
      t,
    );
  }

  /** Run status (+ artifact_url once succeeded). */
  async getRun(runId: string): Promise<ReportingShape.RunStatusDto> {
    return withTenantTransaction(async (t) => {
      const run = await this.runs.findById(runId, t);
      if (!run) throw ErrUtils.notFound('Report run not found');
      return this.toRunDto(run);
    });
  }

  /** Export lookup: returns the signed artifact URL only for completed runs. */
  async getRunExport(runId: string): Promise<ReportingShape.RunExportDto> {
    return withTenantTransaction(async (t) => {
      const run = await this.runs.findById(runId, t);
      if (!run) throw ErrUtils.notFound('Report run not found');
      if (run.status !== ReportRunStatus.Succeeded || !run.artifact_url) {
        throw ErrUtils.conflict('Report export is not ready', { status: run.status });
      }
      return { runId: run.id, status: run.status, artifactUrl: run.artifact_url };
    });
  }

  /** Create a recurring report schedule for an existing definition. */
  async createSchedule(
    input: ReportingShape.CreateScheduleInput,
  ): Promise<ReportingShape.ReportScheduleRow> {
    const tenantId = RequestContext.tenantId();
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');

    return withTenantTransaction(async (t) => {
      const definition = await this.definitions.findById(input.definitionId, t);
      if (!definition) throw ErrUtils.notFound('Report definition not found');
      return this.schedules.create(
        {
          tenant_id: tenantId,
          definition_id: definition.id,
          cron: input.cron,
          timezone: input.timezone ?? 'UTC',
          enabled: input.enabled ?? true,
          created_by: userId,
          updated_by: userId,
        },
        t,
      );
    });
  }

  /** Paged list of tenant-scoped report schedules. */
  async listSchedules(
    input: ReportingShape.ListSchedulesInput,
  ): Promise<ReportingShape.ListSchedulesResult> {
    const { page, pageSize } = input;
    return withTenantTransaction(async (t) => {
      const { rows, total } = await this.schedules.list(
        {
          limit: pageSize,
          offset: (page - 1) * pageSize,
          definitionId: input.definitionId,
          enabled: input.enabled,
        },
        t,
      );
      return { data: rows, meta: { total, page, pageSize } };
    });
  }

  /** Patch schedule configuration. */
  async updateSchedule(
    scheduleId: string,
    input: ReportingShape.UpdateScheduleInput,
  ): Promise<ReportingShape.ReportScheduleRow> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');
    return withTenantTransaction(async (t) => {
      const row = await this.schedules.update(scheduleId, { ...input, updated_by: userId }, t);
      if (!row) throw ErrUtils.notFound('Report schedule not found');
      return row;
    });
  }

  /** Delete a schedule. */
  async deleteSchedule(scheduleId: string): Promise<ReportingShape.DeleteScheduleResult> {
    return withTenantTransaction(async (t) => {
      const deleted = await this.schedules.delete(scheduleId, t);
      if (!deleted) throw ErrUtils.notFound('Report schedule not found');
      return { deleted: true };
    });
  }

  private toRunDto(run: ReportingShape.ReportRunRow): ReportingShape.RunStatusDto {
    return {
      runId: run.id,
      definitionId: run.definition_id,
      status: run.status,
      artifactUrl: run.status === ReportRunStatus.Succeeded ? (run.artifact_url ?? null) : null,
      error: run.error ?? null,
      startedAt: run.started_at ?? null,
      finishedAt: run.finished_at ?? null,
    };
  }

  /** Stub signed-URL stand-in for the export artifact (object storage in production). */
  private stubArtifactUrl(runId: string): string {
    return `https://artifacts.aegis.local/reporting/exports/${runId}.csv`;
  }
}
