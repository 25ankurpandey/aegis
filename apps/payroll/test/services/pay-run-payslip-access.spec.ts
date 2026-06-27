/**
 * Payslip read access: `view.all` can inspect tenant-scoped payslips; `view.own` is restricted by
 * employees.user_id, not by caller-supplied employee ids alone. Net pay remains encrypted-only and is
 * deliberately absent from the DTO.
 */
import { PayslipStatus } from '@aegis/shared-enums';

const tx = { tx: true };
const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));

jest.mock('@aegis/db', () => ({
  withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])),
}));
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn() } }));
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: jest.fn() } }));

import { RequestContext } from '@aegis/service-core';
import { PayRunService } from '../../src/services/pay-run.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const slip = {
  id: 'slip-1',
  tenant_id: 'tenant-1',
  pay_run_id: 'run-1',
  employee_id: 'employee-1',
  gross: 100_00,
  taxable_base: 90_00,
  total_tax: 20_00,
  total_deductions: 10_00,
  net_enc: 'encrypted-net-pay',
  currency: 'USD',
  status: PayslipStatus.Calculated,
};

function makeRepo() {
  return {
    listPayslips: jest.fn().mockResolvedValue({ rows: [slip], total: 1 }),
    findPayslipById: jest.fn().mockResolvedValue(slip),
    findPayslipByIdForUser: jest.fn().mockResolvedValue(slip),
  };
}

function service(repo: ReturnType<typeof makeRepo>): PayRunService {
  return new PayRunService(repo as never, {} as never, {} as never);
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 'tenant-1', userId: USER_ID, correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

describe('PayRunService payslip reads — own vs all access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not add an owner filter for view-all payslip lists', async () => {
    const repo = makeRepo();
    const result = await run(() =>
      service(repo).listPayslips({ employeeId: 'employee-2' }, 2, 25, { canViewAll: true }),
    );

    expect(repo.listPayslips).toHaveBeenCalledWith(
      { employeeId: 'employee-2' },
      2,
      25,
      tx,
    );
    expect(result.data[0]).toMatchObject({ id: 'slip-1', employeeId: 'employee-1' });
    expect(result.data[0]).not.toHaveProperty('net_enc');
    expect(result.data[0]).not.toHaveProperty('net');
  });

  it('scopes view-own payslip lists to the authenticated user id', async () => {
    const repo = makeRepo();
    await run(() =>
      service(repo).listPayslips({ employeeId: 'employee-2' }, 1, 10, { canViewAll: false }),
    );

    expect(repo.listPayslips).toHaveBeenCalledWith(
      { employeeId: 'employee-2', userId: USER_ID },
      1,
      10,
      tx,
    );
  });

  it('loads a detail read through the direct all-access path when allowed', async () => {
    const repo = makeRepo();
    await run(() => service(repo).getPayslip('slip-1', { canViewAll: true }));

    expect(repo.findPayslipById).toHaveBeenCalledWith('slip-1', tx);
    expect(repo.findPayslipByIdForUser).not.toHaveBeenCalled();
  });

  it('loads a detail read through the employees.user_id ownership path for view-own', async () => {
    const repo = makeRepo();
    await run(() => service(repo).getPayslip('slip-1', { canViewAll: false }));

    expect(repo.findPayslipByIdForUser).toHaveBeenCalledWith('slip-1', USER_ID, tx);
    expect(repo.findPayslipById).not.toHaveBeenCalled();
  });

  it('returns the same not-found envelope when a view-own payslip belongs to another user', async () => {
    const repo = makeRepo();
    repo.findPayslipByIdForUser.mockResolvedValue(null);

    await expect(run(() => service(repo).getPayslip('slip-1', { canViewAll: false }))).rejects.toThrow(
      'Payslip not found',
    );
  });
});
