import { inject } from 'inversify';
import { ErrUtils, RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { TenantRepository } from '../repositories/tenant.repository';
import { UserRepository } from '../repositories/user.repository';

/** Tenant and tenant-scoped user read service. */
@provideSingleton(TenantService)
export class TenantService {
  constructor(
    @inject(TenantRepository) private readonly tenants: TenantRepository,
    @inject(UserRepository) private readonly users: UserRepository,
  ) {}

  async getCurrentTenant(): Promise<UserManagementShape.TenantDto> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      const row = await this.tenants.findById(tenantId, t);
      if (!row) throw ErrUtils.notFound('Tenant not found');
      return this.toTenantDto(row);
    });
  }

  async listUsers(): Promise<{ data: UserManagementShape.UserDto[] }> {
    return withTenantTransaction(async (t) => ({
      data: (await this.users.list(t)).map((row) => this.toUserDto(row)),
    }));
  }

  async getUser(id: string): Promise<UserManagementShape.UserDto> {
    return withTenantTransaction(async (t) => {
      const row = await this.users.findById(id, t);
      if (!row) throw ErrUtils.notFound('User not found');
      return this.toUserDto(row);
    });
  }

  private toTenantDto(row: UserManagementShape.TenantRow): UserManagementShape.TenantDto {
    return { id: row.id, name: row.name, slug: row.slug, status: row.status };
  }

  private toUserDto(row: UserManagementShape.UserRow): UserManagementShape.UserDto {
    return {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      status: row.status,
    };
  }
}
