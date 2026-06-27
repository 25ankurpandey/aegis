import type { Transaction } from 'sequelize';
import { ReportingShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getReportingContext } from '../models/database-context';

/**
 * Data access for the report-run aggregate (the `report_runs` table + the per-role
 * `report_access_policies` that drive column masking on a run). Every method runs inside the ambient
 * RLS-scoped `Transaction` opened by the service via `withTenantTransaction`.
 */
@provideSingleton(ReportRunRepository)
export class ReportRunRepository {
  async create(data: ReportingShape.CreateRunRow, t: Transaction): Promise<ReportingShape.ReportRunRow> {
    const { ReportRun } = getReportingContext();
    const row = await ReportRun.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ReportingShape.ReportRunRow;
  }

  async findById(id: string, t: Transaction): Promise<ReportingShape.ReportRunRow | null> {
    const { ReportRun } = getReportingContext();
    const row = await ReportRun.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as ReportingShape.ReportRunRow) : null;
  }

  async list(
    params: ReportingShape.ListRunsOpts,
    t: Transaction,
  ): Promise<ReportingShape.Paged<ReportingShape.ReportRunRow>> {
    const { ReportRun } = getReportingContext();
    const where: Record<string, unknown> = {};
    if (params.definitionId) where['definition_id'] = params.definitionId;
    if (params.status) where['status'] = params.status;
    const result = await ReportRun.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: params.limit,
      offset: params.offset,
      transaction: t,
    });
    return {
      rows: result.rows.map((r) => r.get({ plain: true }) as ReportingShape.ReportRunRow),
      total: result.count,
    };
  }

  async update(
    id: string,
    patch: ReportingShape.UpdateRunRow,
    t: Transaction,
  ): Promise<ReportingShape.ReportRunRow | null> {
    const { ReportRun } = getReportingContext();
    const row = await ReportRun.findByPk(id, { transaction: t });
    if (!row) return null;
    await row.update(patch, { transaction: t });
    return row.get({ plain: true }) as ReportingShape.ReportRunRow;
  }

  /** Load the per-role access policy that drives column masking + the row filter (§5). */
  async findAccessPolicyByRole(
    role: string,
    t: Transaction,
  ): Promise<ReportingShape.ReportAccessPolicyRow | null> {
    const { ReportAccessPolicy } = getReportingContext();
    const row = await ReportAccessPolicy.findOne({ where: { role }, transaction: t });
    return row ? (row.get({ plain: true }) as ReportingShape.ReportAccessPolicyRow) : null;
  }
}
