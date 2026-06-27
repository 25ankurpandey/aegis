/**
 * W5-07 — the optimistic-lock guard on pay-run status transitions. `updatePayRunVersioned` writes
 * with `WHERE id = ? AND lock_version = ?` and increments the version atomically; a stale writer
 * (whose expected version no longer matches) updates zero rows and is rejected as a conflict, so two
 * concurrent approve/disburse calls can never both pass `assertStatus`.
 */
const PayRunModel = {
  update: jest.fn(),
  findByPk: jest.fn(),
};

jest.mock('../../src/models/database-context', () => ({
  getPayrollContext: () => ({ PayRun: PayRunModel }),
}));

import { PayRunRepository } from '../../src/repositories/pay-run.repository';

describe('PayRunRepository.updatePayRunVersioned (W5-07)', () => {
  beforeEach(() => {
    PayRunModel.update.mockReset();
    PayRunModel.findByPk.mockReset();
  });

  it('increments lock_version and guards the WHERE on the expected version', async () => {
    PayRunModel.update.mockResolvedValue([1]);
    PayRunModel.findByPk.mockResolvedValue({
      get: () => ({ id: 'run-1', status: 'approved', lock_version: 6 }),
    });
    const repo = new PayRunRepository();

    const row = await repo.updatePayRunVersioned('run-1', 5, { status: 'approved' }, {} as never);

    expect(PayRunModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', lock_version: 6 }),
      expect.objectContaining({ where: { id: 'run-1', lock_version: 5 } }),
    );
    expect(row.status).toBe('approved');
  });

  it('rejects (conflict) when zero rows match — a stale/lost concurrent transition', async () => {
    PayRunModel.update.mockResolvedValue([0]);
    const repo = new PayRunRepository();

    await expect(
      repo.updatePayRunVersioned('run-1', 5, { status: 'approved' }, {} as never),
    ).rejects.toThrow(/concurrent|stale/i);
    // Never reads back a row when the guarded write lost.
    expect(PayRunModel.findByPk).not.toHaveBeenCalled();
  });
});
