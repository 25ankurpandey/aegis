import type { Transaction } from 'sequelize';
import { ReportingShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getReportingContext } from '../models/database-context';

/** Data access for the tenant-scoped `report_schedules` configuration aggregate. */
@provideSingleton(ReportScheduleRepository)
export class ReportScheduleRepository {
  async create(
    data: ReportingShape.CreateScheduleRow,
    t: Transaction,
  ): Promise<ReportingShape.ReportScheduleRow> {
    const { ReportSchedule } = getReportingContext();
    const row = await ReportSchedule.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ReportingShape.ReportScheduleRow;
  }

  async findById(id: string, t: Transaction): Promise<ReportingShape.ReportScheduleRow | null> {
    const { ReportSchedule } = getReportingContext();
    const row = await ReportSchedule.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as ReportingShape.ReportScheduleRow) : null;
  }

  async list(
    params: ReportingShape.ListSchedulesOpts,
    t: Transaction,
  ): Promise<ReportingShape.Paged<ReportingShape.ReportScheduleRow>> {
    const { ReportSchedule } = getReportingContext();
    const where: Record<string, unknown> = {};
    if (params.definitionId) where['definition_id'] = params.definitionId;
    if (params.enabled !== undefined) where['enabled'] = params.enabled;
    const result = await ReportSchedule.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: params.limit,
      offset: params.offset,
      transaction: t,
    });
    return {
      rows: result.rows.map((r) => r.get({ plain: true }) as ReportingShape.ReportScheduleRow),
      total: result.count,
    };
  }

  async update(
    id: string,
    patch: ReportingShape.UpdateScheduleRow,
    t: Transaction,
  ): Promise<ReportingShape.ReportScheduleRow | null> {
    const { ReportSchedule } = getReportingContext();
    const row = await ReportSchedule.findByPk(id, { transaction: t });
    if (!row) return null;
    await row.update(patch, { transaction: t });
    return row.get({ plain: true }) as ReportingShape.ReportScheduleRow;
  }

  async delete(id: string, t: Transaction): Promise<boolean> {
    const { ReportSchedule } = getReportingContext();
    const deleted = await ReportSchedule.destroy({ where: { id }, transaction: t });
    return deleted > 0;
  }
}
