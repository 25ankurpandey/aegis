import { inject } from 'inversify';
import { ErrUtils, RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { PolicyRepository } from '../repositories/policy.repository';

/** ABAC policy administration service (PAP storage). */
@provideSingleton(PolicyService)
export class PolicyService {
  constructor(@inject(PolicyRepository) private readonly policies: PolicyRepository) {}

  async list(): Promise<{ data: UserManagementShape.PolicyDto[] }> {
    return withTenantTransaction(async (t) => ({
      data: (await this.policies.list(t)).map((row) => this.toDto(row)),
    }));
  }

  async create(input: UserManagementShape.CreatePolicyInput): Promise<UserManagementShape.PolicyDto> {
    const tenantId = RequestContext.tenantId();
    const actorId = RequestContext.userId() ?? null;
    return withTenantTransaction(async (t) =>
      this.toDto(
        await this.policies.create(
          {
            tenant_id: tenantId,
            permission: input.permission,
            effect: input.effect,
            rule: input.rule ?? {},
            priority: input.priority ?? 100,
            is_active: input.isActive ?? true,
            created_by: actorId,
            updated_by: actorId,
          },
          t,
        ),
      ),
    );
  }

  async update(id: string, input: UserManagementShape.UpdatePolicyInput): Promise<UserManagementShape.PolicyDto> {
    const actorId = RequestContext.userId() ?? null;
    return withTenantTransaction(async (t) => {
      const row = await this.policies.update(
        id,
        stripUndefined({
          permission: input.permission,
          effect: input.effect,
          rule: input.rule,
          priority: input.priority,
          is_active: input.isActive,
          updated_by: actorId,
        }),
        t,
      );
      if (!row) throw ErrUtils.notFound('Policy not found');
      return this.toDto(row);
    });
  }

  async delete(id: string): Promise<{ deleted: true }> {
    return withTenantTransaction(async (t) => {
      if (!(await this.policies.delete(id, t))) throw ErrUtils.notFound('Policy not found');
      return { deleted: true };
    });
  }

  private toDto(row: UserManagementShape.PolicyRow): UserManagementShape.PolicyDto {
    return {
      id: row.id,
      permission: row.permission,
      effect: row.effect,
      rule: row.rule,
      priority: row.priority,
      isActive: row.is_active,
    };
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
