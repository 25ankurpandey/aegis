import { Op, type Transaction, type CreationAttributes, type Model } from 'sequelize';
import { ErrUtils } from '@aegis/service-core';
import { PayrollShape } from '@aegis/shared-types';
import { ApprovalRecordType, TableName } from '@aegis/shared-enums';
import { withRecordAnnotationListFilters } from '@aegis/db';
import { provideSingleton } from '../ioc/container';
import { getPayrollContext } from '../models/database-context';

/**
 * Data access for the pay-run aggregate (`pay_runs` + its `payslips`, `payments`, `payment_batches`,
 * and append-only `ledger_entries`). Every method takes the ambient RLS-scoped `Transaction` opened
 * by the service via `withTenantTransaction`, so all reads/writes are tenant-isolated by Postgres
 * Row-Level Security.
 */
@provideSingleton(PayRunRepository)
export class PayRunRepository {
  // ---- pay-runs ----

  async createPayRun(
    data: PayrollShape.CreatePayRunRow,
    t: Transaction,
  ): Promise<PayrollShape.PayRunRow> {
    const { PayRun } = getPayrollContext();
    const row = await PayRun.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as PayrollShape.PayRunRow;
  }

  async findPayRunById(id: string, t: Transaction): Promise<PayrollShape.PayRunRow | null> {
    const { PayRun } = getPayrollContext();
    const row = await PayRun.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as PayrollShape.PayRunRow) : null;
  }

  async listPayRuns(
    filter: PayrollShape.PayRunListFilter,
    page: number,
    pageSize: number,
    t: Transaction,
  ): Promise<{ rows: PayrollShape.PayRunRow[]; total: number }> {
    const { PayRun } = getPayrollContext();
    const where = withRecordAnnotationListFilters({}, filter, {
      tableName: TableName.PayRuns,
      recordType: ApprovalRecordType.PayRun,
      sequelize: getPayrollContext().sequelize,
    });
    const result = await PayRun.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: pageSize,
      offset: (page - 1) * pageSize,
      transaction: t,
    });
    return {
      rows: result.rows.map((r) => r.get({ plain: true }) as PayrollShape.PayRunRow),
      total: result.count,
    };
  }

  async updatePayRun(
    id: string,
    patch: Partial<PayrollShape.PayRunRow>,
    t: Transaction,
  ): Promise<PayrollShape.PayRunRow> {
    const { PayRun } = getPayrollContext();
    await PayRun.update(patch, { where: { id }, transaction: t });
    const row = await PayRun.findByPk(id, { transaction: t });
    return row!.get({ plain: true }) as PayrollShape.PayRunRow;
  }

  /**
   * Apply a status-transition patch with an OPTIMISTIC-LOCK guard (W5-07). The status machine
   * (calculate/approve/disburse) is read-modify-write; `assertStatus` alone lets two concurrent
   * writers both pass the status check and lost-update one transition. Here we guard the write on the
   * `lock_version` we read, so a stale writer's `UPDATE ... WHERE id = ? AND lock_version = ?` matches
   * zero rows and is rejected as a conflict — the second approve/disburse loses cleanly. The version
   * column is incremented atomically with the patch. `expectedVersion` comes from the row the caller
   * already loaded inside the same RLS-scoped transaction.
   */
  async updatePayRunVersioned(
    id: string,
    expectedVersion: number,
    patch: Partial<PayrollShape.PayRunRow>,
    t: Transaction,
  ): Promise<PayrollShape.PayRunRow> {
    const { PayRun } = getPayrollContext();
    const [affected] = await PayRun.update(
      { ...patch, lock_version: expectedVersion + 1 } as Partial<CreationAttributes<Model>>,
      { where: { id, lock_version: expectedVersion }, transaction: t },
    );
    if (affected === 0) {
      // Either the row vanished (RLS/delete) or another writer bumped the version first. Both mean
      // this transition raced and lost — surface a conflict rather than silently no-op'ing.
      throw ErrUtils.conflict(
        'Pay run was modified concurrently (stale version); reload and retry the transition',
      );
    }
    const row = await PayRun.findByPk(id, { transaction: t });
    return row!.get({ plain: true }) as PayrollShape.PayRunRow;
  }

  /**
   * Persist the workflow-rule annotations (`team_id` / `tags`). Used by the RecordUpdated consumer to
   * apply an `assign_team` / `add_tag` action to the record it owns; the service computes the merged
   * values (team set, tags unioned) and passes only the changed fields. Atomic within the RLS tx.
   */
  async applyLabels(
    id: string,
    patch: { team_id?: string | null; assignee_id?: string | null; tags?: string[] | null },
    t: Transaction,
  ): Promise<void> {
    const { PayRun } = getPayrollContext();
    const row = await PayRun.findByPk(id, { transaction: t });
    if (!row) return;
    await row.update(patch, { transaction: t });
  }

  // ---- payslips ----

  async createPayslip(
    data: PayrollShape.CreatePayslipRow,
    t: Transaction,
  ): Promise<PayrollShape.PayslipRow> {
    const { Payslip } = getPayrollContext();
    const row = await Payslip.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as PayrollShape.PayslipRow;
  }

  async listPayslipsByRun(payRunId: string, t: Transaction): Promise<PayrollShape.PayslipRow[]> {
    const { Payslip } = getPayrollContext();
    const rows = await Payslip.findAll({ where: { pay_run_id: payRunId }, transaction: t });
    return rows.map((r) => r.get({ plain: true }) as PayrollShape.PayslipRow);
  }

  async findPayslipById(id: string, t: Transaction): Promise<PayrollShape.PayslipRow | null> {
    const { Payslip } = getPayrollContext();
    const row = await Payslip.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as PayrollShape.PayslipRow) : null;
  }

  async findPayslipByIdForUser(
    id: string,
    userId: string,
    t: Transaction,
  ): Promise<PayrollShape.PayslipRow | null> {
    const row = await this.findPayslipById(id, t);
    if (!row) return null;
    const { Employee } = getPayrollContext();
    const owner = await Employee.findOne({
      where: { id: row.employee_id, user_id: userId },
      transaction: t,
    });
    return owner ? row : null;
  }

  async listPayslips(
    filter: PayrollShape.PayslipListFilter,
    page: number,
    pageSize: number,
    t: Transaction,
  ): Promise<{ rows: PayrollShape.PayslipRow[]; total: number }> {
    const { Payslip } = getPayrollContext();
    const where: Record<string, unknown> = {};
    if (filter.payRunId) where['pay_run_id'] = filter.payRunId;
    if (filter.userId) {
      const employeeIds = await this.employeeIdsForUser(filter.userId, t);
      if (employeeIds.length === 0) return { rows: [], total: 0 };
      if (filter.employeeId && !employeeIds.includes(filter.employeeId)) {
        return { rows: [], total: 0 };
      }
      where['employee_id'] = filter.employeeId ?? { [Op.in]: employeeIds };
    } else if (filter.employeeId) {
      where['employee_id'] = filter.employeeId;
    }
    if (filter.status) where['status'] = filter.status;
    const result = await Payslip.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: pageSize,
      offset: (page - 1) * pageSize,
      transaction: t,
    });
    return {
      rows: result.rows.map((r) => r.get({ plain: true }) as PayrollShape.PayslipRow),
      total: result.count,
    };
  }

  private async employeeIdsForUser(userId: string, t: Transaction): Promise<string[]> {
    const { Employee } = getPayrollContext();
    const rows = await Employee.findAll({
      attributes: ['id'],
      where: { user_id: userId },
      transaction: t,
    });
    return rows.map((r) => String(r.get('id')));
  }

  async updatePayslipTotals(
    id: string,
    patch: PayrollShape.UpdatePayslipTotalsRow,
    t: Transaction,
  ): Promise<void> {
    const { Payslip } = getPayrollContext();
    await Payslip.update(patch, { where: { id }, transaction: t });
  }

  // ---- payments (idempotent) ----

  async findPaymentByIdempotencyKey(
    key: string,
    t: Transaction,
  ): Promise<PayrollShape.PaymentRow | null> {
    const { Payment } = getPayrollContext();
    const row = await Payment.findOne({ where: { idempotency_key: key }, transaction: t });
    return row ? (row.get({ plain: true }) as PayrollShape.PaymentRow) : null;
  }

  async createPayment(
    data: PayrollShape.CreatePaymentRow,
    t: Transaction,
  ): Promise<PayrollShape.PaymentRow> {
    const { Payment } = getPayrollContext();
    const row = await Payment.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as PayrollShape.PaymentRow;
  }

  async createPaymentBatch(
    data: PayrollShape.CreatePaymentBatchRow,
    t: Transaction,
  ): Promise<{ id: string }> {
    const { PaymentBatch } = getPayrollContext();
    const row = await PaymentBatch.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as { id: string };
  }

  // ---- ledger (append-only) ----

  async appendLedgerEntry(
    data: PayrollShape.AppendLedgerEntryRow,
    t: Transaction,
  ): Promise<PayrollShape.LedgerEntryRow> {
    const { LedgerEntry } = getPayrollContext();
    const row = await LedgerEntry.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as PayrollShape.LedgerEntryRow;
  }

  /** Aggregate the run's ledger into a header-level account → {debit, credit} GL summary. */
  async glSummaryForRun(payRunId: string, t: Transaction): Promise<PayrollShape.GlSummary> {
    const { LedgerEntry } = getPayrollContext();
    const rows = await LedgerEntry.findAll({ where: { pay_run_id: payRunId }, transaction: t });
    const summary: PayrollShape.GlSummary = {};
    for (const r of rows) {
      const e = r.get({ plain: true }) as PayrollShape.LedgerEntryRow;
      const acc = (summary[e.account] ??= { debit: 0, credit: 0 });
      acc.debit += Number(e.debit);
      acc.credit += Number(e.credit);
    }
    return summary;
  }
}
