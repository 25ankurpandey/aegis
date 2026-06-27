import { inject } from 'inversify';
import { ErrUtils } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import type { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { UserRepository } from '../repositories/user.repository';

/**
 * Internal recipient directory for notification fan-out. This is service-to-service only: it exposes
 * minimal contact projections, never password/profile rows, and every lookup runs under tenant RLS.
 */
@provideSingleton(RecipientDirectoryService)
export class RecipientDirectoryService {
  constructor(@inject(UserRepository) private readonly users: UserRepository) {}

  async getUserContact(userId: string): Promise<UserManagementShape.UserContactDto> {
    return withTenantTransaction(async (t) => {
      const contact = await this.users.getContactById(userId, t);
      if (!contact) throw ErrUtils.notFound('User contact not found');
      return contact;
    });
  }

  async listRecipients(
    query: UserManagementShape.RecipientDirectoryQuery,
  ): Promise<UserManagementShape.UserContactDto[]> {
    return withTenantTransaction((t) => {
      if (query.tenantAdmins) return this.users.listTenantAdminContacts(t);
      if (query.role) return this.users.listContactsByRole(query.role, t);
      if (query.groupId) return this.users.listContactsByTeam(query.groupId, t);
      return Promise.resolve([]);
    });
  }
}
