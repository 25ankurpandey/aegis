import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { getSequelize, createModelRegistry } from '@aegis/db';
import { defineReportDefinition } from './report-definition.model';
import { defineReportSchedule } from './report-schedule.model';
import { defineReportRun } from './report-run.model';
import { defineReportAccessPolicy } from './report-access-policy.model';

type M = ModelStatic<Model>;

/** The set of reporting control models, registered on the shared connection (the service's DatabaseContext). */
export interface ReportingContext {
  ReportDefinition: M;
  ReportSchedule: M;
  ReportRun: M;
  ReportAccessPolicy: M;
  sequelize: Sequelize;
}

let ctx: ReportingContext | null = null;

/**
 * Defines every reporting control model on the shared `getSequelize()` connection (once), wires the
 * associations, and returns the assembled context. These are the write-side of the read service:
 * declarative definitions, schedules, runs, and the per-role column/row access policies. Every table
 * carries tenant_id and is RLS-guarded (see migration). The return shape is unchanged from the
 * previous single-file `context.ts`, so all callers keep working (SPEC §11.1 — one `*.model.ts` per
 * table + a `database-context.ts` that imports + registers them).
 */
export function getReportingContext(): ReportingContext {
  if (ctx) return ctx;
  const s = getSequelize();
  // Single registration path through the registry (W2-09).
  const registry = createModelRegistry(s);

  const ReportDefinition = registry.register(defineReportDefinition(s));
  const ReportSchedule = registry.register(defineReportSchedule(s));
  const ReportRun = registry.register(defineReportRun(s));
  const ReportAccessPolicy = registry.register(defineReportAccessPolicy(s));

  ReportSchedule.belongsTo(ReportDefinition, { foreignKey: 'definition_id', as: 'definition' });
  ReportRun.belongsTo(ReportDefinition, { foreignKey: 'definition_id', as: 'definition' });

  ctx = { ReportDefinition, ReportSchedule, ReportRun, ReportAccessPolicy, sequelize: s };
  return ctx;
}
