import type { ReportRunStatus } from '@aegis/shared-enums';

/**
 * Domain contract for the reporting service (the CQRS-lite read side: declarative report
 * definitions, schedules, asynchronous runs, and per-role column/row access policies).
 * Service-local DTOs, repository row shapes, the report spec, and service inputs all live here
 * (SPEC §11.2 — no domain types defined inside the service). Controllers, repositories, and the
 * service import these from `@aegis/shared-types`; nothing reporting-domain-typed is declared locally.
 */
export namespace ReportingShape {
  // ---- Declarative report spec (data, never raw SQL — compiled against the read model) ----

  /** A measure projection (aggregate + the field it rolls up). */
  export interface ReportMeasure {
    name: string;
    agg: string;
    field: string;
  }

  /** A dimension projection (group-by field + optional time grain). */
  export interface ReportDimension {
    name: string;
    field: string;
    grain?: string;
  }

  /** A filter predicate (field/op/value). */
  export interface ReportFilter {
    field: string;
    op: string;
    value: unknown;
  }

  /** Declarative report spec — measures/dimensions/filters/grain, compiled (never raw SQL from clients). */
  export interface ReportSpec {
    measures?: ReportMeasure[];
    dimensions?: ReportDimension[];
    filters?: ReportFilter[];
    grain?: string;
    source?: string;
  }

  // ---- Persistence row shapes (what repositories return; `*.get({ plain: true })`) ----

  /** A row of the `report_definitions` table. */
  export interface ReportDefinitionRow {
    id: string;
    tenant_id: string;
    name: string;
    spec: ReportSpec;
    required_permission: string;
    created_by: string;
    created_at?: string;
    updated_at?: string;
  }

  /** A row of the `report_schedules` table (cron-driven recurring runs). */
  export interface ReportScheduleRow {
    id: string;
    tenant_id: string;
    definition_id: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    created_by?: string | null;
    updated_by?: string | null;
    created_at?: string;
    updated_at?: string;
  }

  /** A row of the `report_runs` table (the async run lifecycle). */
  export interface ReportRunRow {
    id: string;
    tenant_id: string;
    definition_id: string;
    requested_by: string;
    params: Record<string, unknown>;
    status: ReportRunStatus;
    started_at?: string | null;
    finished_at?: string | null;
    artifact_url?: string | null;
    error?: string | null;
  }

  /** A row of the `report_access_policies` table (per-role column masking + row filter, §5.2). */
  export interface ReportAccessPolicyRow {
    id: string;
    tenant_id: string;
    role: string;
    allowed_columns: string[];
    masked_columns: string[];
    row_filter?: string | null;
  }

  // ---- Repository write inputs ----

  /** Input to create a `report_definitions` row. */
  export interface CreateDefinitionRow {
    tenant_id: string;
    name: string;
    spec: ReportSpec;
    required_permission: string;
    created_by: string;
  }

  /** Input to create a `report_runs` row. */
  export interface CreateRunRow {
    tenant_id: string;
    definition_id: string;
    requested_by: string;
    params: Record<string, unknown>;
    status: ReportRunStatus;
    started_at?: Date | null;
  }

  /** Patch applied to a `report_runs` row as it settles (the worker's update in production). */
  export interface UpdateRunRow {
    status?: ReportRunStatus;
    started_at?: Date | null;
    finished_at?: Date | null;
    artifact_url?: string | null;
    error?: string | null;
  }

  /** Input to create a `report_schedules` row. */
  export interface CreateScheduleRow {
    tenant_id: string;
    definition_id: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    created_by: string | null;
    updated_by: string | null;
  }

  /** Patch applied to a `report_schedules` row. */
  export interface UpdateScheduleRow {
    cron?: string;
    timezone?: string;
    enabled?: boolean;
    updated_by?: string | null;
  }

  // ---- Repository query helpers ----

  /** Offset/limit window for a paged definition list. */
  export interface ListDefinitionsOpts {
    limit: number;
    offset: number;
  }

  /** Offset/limit window for a paged run list. */
  export interface ListRunsOpts {
    limit: number;
    offset: number;
    definitionId?: string;
    status?: ReportRunStatus;
  }

  /** Offset/limit window for a paged schedule list. */
  export interface ListSchedulesOpts {
    limit: number;
    offset: number;
    definitionId?: string;
    enabled?: boolean;
  }

  /** A page of rows + the unfiltered total (for pagination meta). */
  export interface Paged<T> {
    rows: T[];
    total: number;
  }

  // ---- Service inputs (the public method args) ----

  /** Args to `ReportingService.createDefinition`. */
  export interface CreateDefinitionInput {
    name: string;
    spec: ReportSpec;
    requiredPermission?: string;
  }

  /** Args to `ReportingService.listDefinitions`. */
  export interface ListDefinitionsInput {
    page: number;
    pageSize: number;
  }

  /** Args to `ReportingService.createRun`. */
  export interface CreateRunInput {
    definitionId: string;
    params?: Record<string, unknown>;
  }

  /** Args to `ReportingService.listRuns`. */
  export interface ListRunsInput {
    page: number;
    pageSize: number;
    definitionId?: string;
    status?: ReportRunStatus;
  }

  /** Args to `ReportingService.createSchedule`. */
  export interface CreateScheduleInput {
    definitionId: string;
    cron: string;
    timezone?: string;
    enabled?: boolean;
  }

  /** Args to `ReportingService.listSchedules`. */
  export interface ListSchedulesInput {
    page: number;
    pageSize: number;
    definitionId?: string;
    enabled?: boolean;
  }

  /** Args to `ReportingService.updateSchedule`. */
  export interface UpdateScheduleInput {
    cron?: string;
    timezone?: string;
    enabled?: boolean;
  }

  // ---- Service result DTOs (the explicit response shapes) ----

  /** Result of `ReportingService.createRun` — the enqueued run id + its current status (202 body). */
  export interface CreateRunResult {
    runId: string;
    status: string;
  }

  /** A paged list of definitions + pagination meta. */
  export interface ListDefinitionsResult {
    data: ReportDefinitionRow[];
    meta: { total: number; page: number; pageSize: number };
  }

  /** A paged list of run status DTOs + pagination meta. */
  export interface ListRunsResult {
    data: RunStatusDto[];
    meta: { total: number; page: number; pageSize: number };
  }

  /** A paged list of schedules + pagination meta. */
  export interface ListSchedulesResult {
    data: ReportScheduleRow[];
    meta: { total: number; page: number; pageSize: number };
  }

  /** Run status projection (+ artifact_url once succeeded). Result of `ReportingService.getRun`. */
  export interface RunStatusDto {
    runId: string;
    definitionId: string;
    status: ReportRunStatus;
    artifactUrl?: string | null;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }

  /** Export lookup result. The URL is present only after the run succeeds. */
  export interface RunExportDto {
    runId: string;
    status: ReportRunStatus;
    artifactUrl: string;
  }

  /** Delete result for schedule admin APIs. */
  export interface DeleteScheduleResult {
    deleted: boolean;
  }
}
