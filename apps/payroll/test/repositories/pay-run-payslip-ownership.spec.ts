import { Op } from 'sequelize';

const EmployeeModel = {
  findAll: jest.fn(),
  findOne: jest.fn(),
};

const PayslipModel = {
  findAndCountAll: jest.fn(),
  findByPk: jest.fn(),
};

jest.mock('../../src/models/database-context', () => ({
  getPayrollContext: () => ({ Employee: EmployeeModel, Payslip: PayslipModel }),
}));

import { PayRunRepository } from '../../src/repositories/pay-run.repository';

describe('PayRunRepository payslip ownership filters', () => {
  beforeEach(() => {
    EmployeeModel.findAll.mockReset();
    EmployeeModel.findOne.mockReset();
    PayslipModel.findAndCountAll.mockReset();
    PayslipModel.findByPk.mockReset();
  });

  it('intersects caller employeeId with employees.user_id for view-own lists', async () => {
    EmployeeModel.findAll.mockResolvedValue([{ get: () => 'emp-1' }, { get: () => 'emp-2' }]);
    PayslipModel.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    const repo = new PayRunRepository();

    await repo.listPayslips(
      { userId: 'user-1', employeeId: 'emp-2', payRunId: 'run-1' },
      1,
      10,
      {} as never,
    );

    expect(EmployeeModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ attributes: ['id'], where: { user_id: 'user-1' } }),
    );
    expect(PayslipModel.findAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pay_run_id: 'run-1', employee_id: 'emp-2' },
      }),
    );
  });

  it('returns an empty page when the requested employee does not belong to the user', async () => {
    EmployeeModel.findAll.mockResolvedValue([{ get: () => 'emp-1' }]);
    const repo = new PayRunRepository();

    const result = await repo.listPayslips(
      { userId: 'user-1', employeeId: 'other-employee' },
      1,
      10,
      {} as never,
    );

    expect(result).toEqual({ rows: [], total: 0 });
    expect(PayslipModel.findAndCountAll).not.toHaveBeenCalled();
  });

  it('uses an employee id IN filter when view-own lists do not specify employeeId', async () => {
    EmployeeModel.findAll.mockResolvedValue([{ get: () => 'emp-1' }]);
    PayslipModel.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    const repo = new PayRunRepository();

    await repo.listPayslips({ userId: 'user-1' }, 1, 10, {} as never);

    expect(PayslipModel.findAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { employee_id: { [Op.in]: ['emp-1'] } },
      }),
    );
  });

  it('checks employees.user_id on view-own detail reads', async () => {
    PayslipModel.findByPk.mockResolvedValue({ get: () => ({ id: 'slip-1', employee_id: 'emp-1' }) });
    EmployeeModel.findOne.mockResolvedValue({ get: () => ({ id: 'emp-1' }) });
    const repo = new PayRunRepository();

    const row = await repo.findPayslipByIdForUser('slip-1', 'user-1', {} as never);

    expect(row).toEqual({ id: 'slip-1', employee_id: 'emp-1' });
    expect(EmployeeModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'emp-1', user_id: 'user-1' } }),
    );
  });
});
