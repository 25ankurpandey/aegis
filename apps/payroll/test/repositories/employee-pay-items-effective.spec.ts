/**
 * Regression — `EmployeeRepository.findActivePayItemsForEmployee` must only return pay items whose
 * effective-date window contains the run's pay date (`effective_from <= payDate` AND `effective_to`
 * null-or-`>= payDate`), mirroring `findEffectiveTaxRules` / `findContractCurrencyForEmployee`.
 *
 * Previously the method returned ALL of an employee's `employee_pay_items` regardless of their window,
 * so the pay-run engine summed earnings/deductions not in effect for the period — a FUTURE-dated raise
 * or an already-ENDED recurring deduction would still be included. This test feeds a fixture set into a
 * `findAll` mock that honours the Sequelize `where` the repo builds (interpreting the `Op.lte`/`Op.or`/
 * `Op.gte` operators), and proves the out-of-window items are excluded.
 */
import { Op } from 'sequelize';

const EmployeePayItemModel = { findAll: jest.fn() };

jest.mock('../../src/models/database-context', () => ({
  getPayrollContext: () => ({ EmployeePayItem: EmployeePayItemModel }),
}));

import { EmployeeRepository } from '../../src/repositories/employee.repository';

const EMP = 'emp-1';
const PAY_DATE = '2026-01-31';

// Plain `employee_pay_items` rows (DATEONLY columns are 'YYYY-MM-DD' strings).
const IN_WINDOW = { id: 'pi-in', employee_id: EMP, code_kind: 'earning', amount_or_rate: 5_000_00, effective_from: '2026-01-01', effective_to: null };
const BOUNDARY_END = { id: 'pi-boundary', employee_id: EMP, code_kind: 'deduction', amount_or_rate: 100_00, effective_from: '2025-12-01', effective_to: PAY_DATE }; // effective_to == payDate ⇒ still in effect
const FUTURE_RAISE = { id: 'pi-future', employee_id: EMP, code_kind: 'earning', amount_or_rate: 9_999_00, effective_from: '2026-06-01', effective_to: null }; // not yet effective
const ENDED_DEDUCTION = { id: 'pi-ended', employee_id: EMP, code_kind: 'deduction', amount_or_rate: 250_00, effective_from: '2025-01-01', effective_to: '2025-12-31' }; // already ended
const OTHER_EMPLOYEE = { id: 'pi-other', employee_id: 'emp-2', code_kind: 'earning', amount_or_rate: 1_00, effective_from: '2026-01-01', effective_to: null };

const ALL_ROWS = [IN_WINDOW, BOUNDARY_END, FUTURE_RAISE, ENDED_DEDUCTION, OTHER_EMPLOYEE];

/**
 * Evaluate exactly the `where` shape the repo builds against one plain row — enough to prove the
 * effective-date window genuinely filters (not a structural assertion that could rot). ISO date
 * strings compare correctly lexicographically.
 */
type Row = (typeof ALL_ROWS)[number];
function matchesWhere(row: Row, where: Record<string | symbol, unknown>): boolean {
  if (where.employee_id !== undefined && row.employee_id !== where.employee_id) return false;

  const fromCond = where.effective_from as { [Op.lte]?: string } | undefined;
  const lte = fromCond?.[Op.lte];
  if (lte !== undefined && !(row.effective_from <= lte)) return false;

  const orBranches = where[Op.or] as Array<{ effective_to: null | { [Op.gte]?: string } }> | undefined;
  if (orBranches) {
    const ok = orBranches.some((branch) => {
      const cond = branch.effective_to;
      if (cond === null) return row.effective_to === null;
      const gte = cond?.[Op.gte];
      return gte !== undefined && row.effective_to !== null && row.effective_to >= gte;
    });
    if (!ok) return false;
  }
  return true;
}

describe('EmployeeRepository.findActivePayItemsForEmployee — effective-date window', () => {
  beforeEach(() => {
    EmployeePayItemModel.findAll.mockReset();
    EmployeePayItemModel.findAll.mockImplementation(async ({ where }: { where: Record<string | symbol, unknown> }) =>
      ALL_ROWS.filter((row) => matchesWhere(row, where)).map((row) => ({ get: () => row })),
    );
  });

  it('excludes a future-dated raise and an already-ended deduction; keeps the in-window items', async () => {
    const repo = new EmployeeRepository();

    const items = await repo.findActivePayItemsForEmployee(EMP, PAY_DATE, {} as never);
    const ids = items.map((i) => i.id);

    // In effect on the pay date (including the boundary effective_to === payDate).
    expect(ids).toEqual(expect.arrayContaining(['pi-in', 'pi-boundary']));
    // The regression: out-of-window items must NOT be summed into the period.
    expect(ids).not.toContain('pi-future'); // effective_from after the pay date
    expect(ids).not.toContain('pi-ended'); // effective_to before the pay date
    // RLS aside, the employee filter still scopes to this employee.
    expect(ids).not.toContain('pi-other');
    expect(items).toHaveLength(2);
  });

  it('passes the effective-date window to the query (effective_from <= payDate, effective_to null-or->= payDate)', async () => {
    const repo = new EmployeeRepository();

    await repo.findActivePayItemsForEmployee(EMP, PAY_DATE, {} as never);

    expect(EmployeePayItemModel.findAll).toHaveBeenCalledTimes(1);
    const where = EmployeePayItemModel.findAll.mock.calls[0][0].where as Record<string | symbol, unknown>;
    expect(where.employee_id).toBe(EMP);
    expect((where.effective_from as Record<symbol, unknown>)[Op.lte]).toBe(PAY_DATE);
    const orBranches = where[Op.or] as Array<Record<string, unknown>>;
    expect(orBranches).toEqual([
      { effective_to: null },
      { effective_to: { [Op.gte]: PAY_DATE } },
    ]);
  });
});
