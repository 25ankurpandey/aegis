import 'reflect-metadata';
import type { Transaction } from 'sequelize';

jest.mock('@aegis/db', () => ({
  withTenantTransaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> => fn({} as Transaction),
}));

import { RecipientDirectoryService } from '../../src/services/recipient-directory.service';
import type { UserRepository } from '../../src/repositories/user.repository';

function makeService(overrides: Partial<UserRepository> = {}) {
  const users = {
    getContactById: jest.fn().mockResolvedValue({ userId: 'u1', email: 'u1@example.com' }),
    listTenantAdminContacts: jest.fn().mockResolvedValue([{ userId: 'owner', email: 'owner@example.com' }]),
    listContactsByRole: jest.fn().mockResolvedValue([{ userId: 'approver', email: 'approver@example.com' }]),
    listContactsByTeam: jest.fn().mockResolvedValue([{ userId: 'member', email: 'member@example.com' }]),
    ...overrides,
  } as unknown as UserRepository;
  return { service: new RecipientDirectoryService(users), users };
}

describe('RecipientDirectoryService', () => {
  it('returns the minimal contact projection for one active user', async () => {
    const { service } = makeService();
    await expect(service.getUserContact('u1')).resolves.toEqual({
      userId: 'u1',
      email: 'u1@example.com',
    });
  });

  it('fails closed when the requested contact is not available in this tenant', async () => {
    const { service } = makeService({ getContactById: jest.fn().mockResolvedValue(null) } as unknown as UserRepository);
    await expect(service.getUserContact('missing')).rejects.toThrow(/not found/i);
  });

  it('resolves tenant-admin audiences through owner/admin role membership', async () => {
    const { service, users } = makeService();
    await expect(service.listRecipients({ tenantAdmins: true })).resolves.toEqual([
      { userId: 'owner', email: 'owner@example.com' },
    ]);
    expect(users.listTenantAdminContacts).toHaveBeenCalledTimes(1);
  });

  it('resolves role and team audiences through the repository seam', async () => {
    const { service, users } = makeService();

    await expect(service.listRecipients({ role: 'approver' })).resolves.toEqual([
      { userId: 'approver', email: 'approver@example.com' },
    ]);
    await expect(service.listRecipients({ groupId: 'team-1' })).resolves.toEqual([
      { userId: 'member', email: 'member@example.com' },
    ]);

    expect(users.listContactsByRole).toHaveBeenCalledWith('approver', {});
    expect(users.listContactsByTeam).toHaveBeenCalledWith('team-1', {});
  });
});
