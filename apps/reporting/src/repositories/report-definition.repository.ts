import type { Transaction } from 'sequelize';
import { ReportingShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getReportingContext } from '../models/database-context';

/**
 * Data access for the report-definition aggregate (the `report_definitions` table). Every method runs
 * inside the ambient RLS-scoped `Transaction` (the SERVICE opens it via `withTenantTransaction`), so
 * the tenant predicate is always in effect — there is no path here that bypasses RLS.
 */
@provideSingleton(ReportDefinitionRepository)
export class ReportDefinitionRepository {
  async create(
    data: ReportingShape.CreateDefinitionRow,
    t: Transaction,
  ): Promise<ReportingShape.ReportDefinitionRow> {
    const { ReportDefinition } = getReportingContext();
    const row = await ReportDefinition.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ReportingShape.ReportDefinitionRow;
  }

  async list(
    opts: ReportingShape.ListDefinitionsOpts,
    t: Transaction,
  ): Promise<ReportingShape.Paged<ReportingShape.ReportDefinitionRow>> {
    const { ReportDefinition } = getReportingContext();
    const { rows, count } = await ReportDefinition.findAndCountAll({
      order: [['created_at', 'DESC']],
      limit: opts.limit,
      offset: opts.offset,
      transaction: t,
    });
    return {
      rows: rows.map((r) => r.get({ plain: true }) as ReportingShape.ReportDefinitionRow),
      total: count,
    };
  }

  async findById(id: string, t: Transaction): Promise<ReportingShape.ReportDefinitionRow | null> {
    const { ReportDefinition } = getReportingContext();
    const row = await ReportDefinition.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as ReportingShape.ReportDefinitionRow) : null;
  }
}
