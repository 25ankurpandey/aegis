/**
 * W5-07 OPTIMISTIC LOCK ON INVOICES.
 *
 * The invoices model maps Sequelize `version: true` → `lock_version`, but optimistic locking only
 * engages on INSTANCE saves — a static `Model.update()` bypasses it. `InvoiceRepository.updateStatus`
 * now loads the instance and `save()`s it (so Sequelize appends `WHERE lock_version = ?` and
 * increments the counter), and accepts the version the caller observed at its status gate. These
 * tests prove a STALE-version transition is rejected (409) on both paths: (a) the up-front
 * expected-version mismatch, and (b) a Sequelize `OptimisticLockError` thrown by the racing save.
 * The model registry / connection is stubbed via a fake Invoice model — no real Postgres.
 */
import { OptimisticLockError } from 'sequelize';

const getInvoiceContext = jest.fn();
jest.mock('../../src/models/database-context', () => ({ getInvoiceContext: () => getInvoiceContext() }));

import { InvoiceStatus } from '@aegis/shared-enums';
import { InvoiceRepository } from '../../src/repositories/invoice.repository';

const ID = 'inv-1';
const t = {} as never;

/** A fake Sequelize instance whose lock_version is `version` and whose update() is `onUpdate`. */
function fakeInstance(version: number, onUpdate: jest.Mock) {
  return {
    get: (key: string) => (key === 'lock_version' ? version : undefined),
    update: onUpdate,
  };
}

function repoWith(instance: unknown) {
  getInvoiceContext.mockReturnValue({ Invoice: { findByPk: jest.fn().mockResolvedValue(instance) } });
  return new InvoiceRepository();
}

beforeEach(() => getInvoiceContext.mockReset());

describe('updateStatus — version-checked', () => {
  it('applies the patch via an instance save when the expected version matches', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const repo = repoWith(fakeInstance(3, update));

    await repo.updateStatus(ID, { status: InvoiceStatus.ForApproval }, t, 3);

    expect(update).toHaveBeenCalledWith({ status: InvoiceStatus.ForApproval }, { transaction: t });
  });

  it('rejects a STALE expected version (row already advanced) with a 409 conflict', async () => {
    const update = jest.fn();
    const repo = repoWith(fakeInstance(5, update)); // row is at v5...

    await expect(
      repo.updateStatus(ID, { status: InvoiceStatus.Approved }, t, 3), // ...caller observed v3
    ).rejects.toMatchObject({ status: 409 });
    // The stale transition must never reach the write.
    expect(update).not.toHaveBeenCalled();
  });

  it('maps a Sequelize OptimisticLockError from the racing save to a 409 conflict', async () => {
    const update = jest.fn().mockRejectedValue(
      new OptimisticLockError({ modelName: 'invoices', where: {} } as never),
    );
    const repo = repoWith(fakeInstance(3, update));

    await expect(
      repo.updateStatus(ID, { status: InvoiceStatus.Approved }, t, 3),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('still version-checks (instance save) when no expectedVersion is supplied', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const repo = repoWith(fakeInstance(0, update));

    await repo.updateStatus(ID, { status: InvoiceStatus.Validating }, t);

    expect(update).toHaveBeenCalledWith({ status: InvoiceStatus.Validating }, { transaction: t });
  });

  it('404s when the invoice row is gone', async () => {
    const repo = repoWith(null);
    await expect(
      repo.updateStatus(ID, { status: InvoiceStatus.Approved }, t),
    ).rejects.toMatchObject({ status: 404 });
  });
});
