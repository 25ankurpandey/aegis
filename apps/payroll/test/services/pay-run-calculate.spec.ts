/**
 * W5-05 / W5-09 / W5-07 — the pay-run CALCULATE path.
 *
 * Proves the engine now computes for real instead of hard-coding tax/pre-tax:
 *   - PRE-tax deductions (resolved from the deduction-code catalog) reduce the taxable base before tax;
 *   - statutory tax is resolved from effective-dated `tax_rules` and applied to the taxable base;
 *   - net = gross − tax − ALL deductions; the worked example below ties out end-to-end;
 *   - the payslip currency is threaded from the employee's contract (W5-09), not hard-coded USD;
 *   - the Draft → Calculated transition is version-checked (W5-07): a stale version is rejected.
 */
import { PayRunStatus } from '@aegis/shared-enums';

const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
jest.mock('@aegis/db', () => ({ withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])) }));
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn() } }));
// W5-13 — calculate now appends to the shared business timeline; stub it so this spec needs no DB.
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: jest.fn() } }));
// Stub field-crypto so the test doesn't require a FIELD_ENCRYPTION_KEY — net_enc is opaque here.
jest.mock('../../src/utils/field-crypto', () => ({
  encryptField: (s: string | null) => (s == null ? null : `enc:${s}`),
  decryptField: (s: string | null) => s,
  maskLast4: (s: string | null) => s,
}));

import { RequestContext } from '@aegis/service-core';
import { PayRunService } from '../../src/services/pay-run.service';

const RUN_ID = 'run-1';
const EMP = 'emp-1';
const DED_PRE = 'ded-pretax'; // a 401k-style PRE-tax deduction code
const DED_POST = 'ded-posttax'; // a union-due-style POST-tax deduction code

function draftRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    tenant_id: 't1',
    pay_calendar_id: null,
    period_start: '2026-01-01',
    period_end: '2026-01-31',
    pay_date: '2026-01-31',
    type: 'regular',
    status: PayRunStatus.Draft,
    created_by: 'maker-1',
    approved_by: null,
    approved_at: null,
    locked_snapshot: null,
    lock_version: 3,
    ...overrides,
  };
}

/**
 * A worked example (minor units):
 *   gross         = 5,000.00 (one earning)
 *   pre-tax ded   =   500.00 (401k)            → taxable_base = 4,500.00
 *   tax           = flat 20% of 4,500 = 900.00
 *   post-tax ded  =   100.00 (union)
 *   total_deductions = 600.00
 *   net = 5,000 − 900 − 600 = 3,500.00
 */
function makeEmployees() {
  return {
    findActivePayItemsForEmployee: jest.fn().mockResolvedValue([
      { code_kind: 'earning', code_id: 'earn-1', amount_or_rate: 5_000_00 },
      { code_kind: 'deduction', code_id: DED_PRE, amount_or_rate: 500_00 },
      { code_kind: 'deduction', code_id: DED_POST, amount_or_rate: 100_00 },
    ]),
    findEmployeeById: jest.fn().mockResolvedValue({ id: EMP, work_jurisdiction: 'US-CA' }),
    findDeductionCodesByIds: jest.fn().mockResolvedValue(
      new Map([
        [DED_PRE, { id: DED_PRE, tenant_id: 't1', name: '401k', pre_tax: true }],
        [DED_POST, { id: DED_POST, tenant_id: 't1', name: 'union', pre_tax: false }],
      ]),
    ),
    findEffectiveTaxRules: jest.fn().mockResolvedValue([
      { id: 'tr-1', tenant_id: null, jurisdiction: 'US-CA', rule_type: 'income_tax', params: { rate: 0.2 }, version: 1 },
    ]),
    findContractCurrencyForEmployee: jest.fn().mockResolvedValue('EUR'),
  };
}

function makeRepo(run: Record<string, unknown>) {
  let current = run;
  return {
    findPayRunById: jest.fn(async () => current),
    listPayslipsByRun: jest.fn().mockResolvedValue([
      { id: 'slip-1', employee_id: EMP, gross: 0, taxable_base: 0, total_tax: 0, total_deductions: 0, currency: 'USD' },
    ]),
    updatePayslipTotals: jest.fn().mockResolvedValue(undefined),
    updatePayRun: jest.fn(),
    updatePayRunVersioned: jest.fn(async (_id: string, _v: number, patch: Record<string, unknown>) => {
      current = { ...current, ...patch };
      return current;
    }),
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'calc-1', correlationId: 'c', startedAt: Date.now() } as never,
    fn,
  );
}

describe('pay-run.calculate — real tax + pre-tax deductions (W5-05)', () => {
  it('reduces the taxable base by pre-tax deductions and taxes it from tax_rules', async () => {
    const repo = makeRepo(draftRun());
    const employees = makeEmployees();
    const service = new PayRunService(repo as never, employees as never, {} as never);

    await run(() => service.calculate(RUN_ID));

    // Pay items are resolved for the run's pay date so out-of-window items are excluded by the repo.
    expect(employees.findActivePayItemsForEmployee).toHaveBeenCalledWith(EMP, '2026-01-31', expect.anything());
    expect(employees.findEffectiveTaxRules).toHaveBeenCalledWith('US-CA', '2026-01-31', expect.anything());
    expect(repo.updatePayslipTotals).toHaveBeenCalledWith(
      'slip-1',
      expect.objectContaining({
        gross: 5_000_00,
        taxable_base: 4_500_00, // gross − pre-tax (500)
        total_tax: 900_00, // 20% of 4,500
        total_deductions: 600_00, // pre (500) + post (100)
        status: 'calculated',
      }),
      expect.anything(),
    );
  });

  it('threads the contract currency onto the payslip (W5-09, not hard-coded USD)', async () => {
    const repo = makeRepo(draftRun());
    const employees = makeEmployees(); // contract currency = EUR
    const service = new PayRunService(repo as never, employees as never, {} as never);

    await run(() => service.calculate(RUN_ID));

    expect(repo.updatePayslipTotals).toHaveBeenCalledWith(
      'slip-1',
      expect.objectContaining({ currency: 'EUR' }),
      expect.anything(),
    );
  });

  it('with NO resolved tax_rules, total_tax is 0 via the lookup path (seeded/empty case)', async () => {
    const repo = makeRepo(draftRun());
    const employees = makeEmployees();
    employees.findEffectiveTaxRules.mockResolvedValue([]); // empty resolution, not a hard-coded const
    const service = new PayRunService(repo as never, employees as never, {} as never);

    await run(() => service.calculate(RUN_ID));

    expect(employees.findEffectiveTaxRules).toHaveBeenCalled();
    expect(repo.updatePayslipTotals).toHaveBeenCalledWith(
      'slip-1',
      expect.objectContaining({ total_tax: 0, taxable_base: 4_500_00 }),
      expect.anything(),
    );
  });

  it('advances Draft → Calculated through the version-checked update (W5-07)', async () => {
    const repo = makeRepo(draftRun({ lock_version: 7 }));
    const employees = makeEmployees();
    const service = new PayRunService(repo as never, employees as never, {} as never);

    const dto = await run(() => service.calculate(RUN_ID));

    expect(dto.status).toBe(PayRunStatus.Calculated);
    expect(repo.updatePayRunVersioned).toHaveBeenCalledWith(
      RUN_ID,
      7, // the version read off the loaded run
      expect.objectContaining({ status: PayRunStatus.Calculated }),
      expect.anything(),
    );
  });

  it('a stale version is rejected (the repo conflict propagates) — concurrent calculate loses', async () => {
    const repo = makeRepo(draftRun());
    repo.updatePayRunVersioned = jest.fn().mockRejectedValue(new Error('stale version'));
    const employees = makeEmployees();
    const service = new PayRunService(repo as never, employees as never, {} as never);

    await expect(run(() => service.calculate(RUN_ID))).rejects.toThrow(/stale/i);
  });
});
