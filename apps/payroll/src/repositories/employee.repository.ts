import { Op, type Transaction } from 'sequelize';
import { PayrollShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getPayrollContext } from '../models/database-context';

/**
 * Data access for the employee aggregate (the `employees` table + the employee's `employee_pay_items`).
 * Every method takes the ambient RLS-scoped `Transaction` (the SERVICE opens it via
 * `withTenantTransaction`), so a tenant only ever sees its own rows.
 */
@provideSingleton(EmployeeRepository)
export class EmployeeRepository {
  // ---- employees ----

  async createEmployee(
    data: PayrollShape.CreateEmployeeRow,
    t: Transaction,
  ): Promise<PayrollShape.EmployeeRow> {
    const { Employee } = getPayrollContext();
    const row = await Employee.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as PayrollShape.EmployeeRow;
  }

  async listEmployees(t: Transaction): Promise<PayrollShape.EmployeeRow[]> {
    const { Employee } = getPayrollContext();
    const rows = await Employee.findAll({ order: [['created_at', 'DESC']], transaction: t });
    return rows.map((r) => r.get({ plain: true }) as PayrollShape.EmployeeRow);
  }

  async findEmployeeById(id: string, t: Transaction): Promise<PayrollShape.EmployeeRow | null> {
    const { Employee } = getPayrollContext();
    const row = await Employee.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as PayrollShape.EmployeeRow) : null;
  }

  // ---- pay-items ----

  /**
   * The employee's pay items IN EFFECT on `payDate` — those whose effective-date window contains the
   * pay date (`effective_from <= payDate` AND `effective_to` is null-or-`>= payDate`), mirroring
   * {@link findEffectiveTaxRules} / {@link findContractCurrencyForEmployee}. A future-dated raise or an
   * already-ended recurring deduction is therefore excluded, so the pay-run engine only ever sums
   * earnings/deductions actually live for the run's pay period (the method name's "Active" is now real).
   */
  async findActivePayItemsForEmployee(
    employeeId: string,
    payDate: string,
    t: Transaction,
  ): Promise<PayrollShape.EmployeePayItemRow[]> {
    const { EmployeePayItem } = getPayrollContext();
    const rows = await EmployeePayItem.findAll({
      where: {
        employee_id: employeeId,
        effective_from: { [Op.lte]: payDate },
        [Op.or]: [{ effective_to: null }, { effective_to: { [Op.gte]: payDate } }],
      },
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as PayrollShape.EmployeePayItemRow);
  }

  /**
   * The currency of the employee's effective compensation on `payDate` — the most recent
   * `employment_contracts` row whose validity window contains the pay date. Drives per-payslip +
   * ledger currency labelling (W5-09) instead of a hard-coded 'USD'. Returns null when the employee
   * has no in-window contract, letting the caller fall back to a run/default currency.
   */
  async findContractCurrencyForEmployee(
    employeeId: string,
    payDate: string,
    t: Transaction,
  ): Promise<string | null> {
    const { EmploymentContract } = getPayrollContext();
    const row = await EmploymentContract.findOne({
      where: {
        employee_id: employeeId,
        effective_from: { [Op.lte]: payDate },
        [Op.or]: [{ effective_to: null }, { effective_to: { [Op.gte]: payDate } }],
      },
      order: [['effective_from', 'DESC']],
      transaction: t,
    });
    if (!row) return null;
    return (row.get('currency') as string) ?? null;
  }

  // ---- deduction codes (the pre-tax flag drives the taxable-base reduction) ----

  /**
   * Load the deduction codes referenced by a set of pay-item `code_id`s, keyed by id. Used by the
   * pay-run engine to decide which deductions are PRE-tax (reduce the taxable base) vs POST-tax.
   * Returns an empty map for an empty input (no query).
   */
  async findDeductionCodesByIds(
    ids: string[],
    t: Transaction,
  ): Promise<Map<string, PayrollShape.DeductionCodeRow>> {
    const map = new Map<string, PayrollShape.DeductionCodeRow>();
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return map;
    const { DeductionCode } = getPayrollContext();
    const rows = await DeductionCode.findAll({ where: { id: unique }, transaction: t });
    for (const r of rows) {
      const row = r.get({ plain: true }) as PayrollShape.DeductionCodeRow;
      map.set(row.id, row);
    }
    return map;
  }

  // ---- tax rules (effective-dated, jurisdiction-keyed; tax is DATA, not code) ----

  /**
   * Resolve the effective-dated tax rules for a `jurisdiction` whose validity window contains
   * `payDate` (`effective_from <= payDate <= effective_to`, with a null `effective_to` meaning
   * open-ended). RLS already restricts visibility to this tenant's rows PLUS the platform-default
   * `tenant_id IS NULL` baseline; we sort so a tenant-specific row outranks the default and a newer
   * `version`/`effective_from` outranks an older one. The service then picks ONE rule per
   * `(rule_type)` — the most specific, most recent — so tenant overrides win cleanly.
   */
  async findEffectiveTaxRules(
    jurisdiction: string,
    payDate: string,
    t: Transaction,
  ): Promise<PayrollShape.TaxRuleRow[]> {
    const { TaxRule, sequelize } = getPayrollContext();
    const rows = await TaxRule.findAll({
      where: {
        jurisdiction,
        effective_from: { [Op.lte]: payDate },
        [Op.or]: [{ effective_to: null }, { effective_to: { [Op.gte]: payDate } }],
      },
      // Most specific (tenant override before platform default), then newest in-window, then version.
      // `tenant_id IS NULL` sorts AFTER a set tenant_id (literal keeps this portable across dialects).
      order: [
        [sequelize.literal('"tenant_id" IS NULL'), 'ASC'],
        ['effective_from', 'DESC'],
        ['version', 'DESC'],
      ],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as PayrollShape.TaxRuleRow);
  }
}
