import { inject } from 'inversify';
import { ErrUtils, RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import { UserManagementShape } from '@aegis/shared-types';
// Same validator the load-time mapper applies (ABAC generalization §3 Q2, §5 Phase 0) — a row the
// PAP accepts is mappable by construction.
import { validatePolicyWrite } from '@aegis/access-control';
import { provideSingleton } from '../ioc/container';
import { PolicyRepository } from '../repositories/policy.repository';

/** Reject a `{permission, effect, rule}` combination the load-time mapper would refuse.
 * Service-level (not just Joi) so every write path is covered, and because a PATCH can only be
 * judged against the MERGED row (§3 Q8 — e.g. flipping `effect` to allow on a `'*'` row). */
function assertWritablePolicy(candidate: { permission: string; effect: string; rule: unknown }): void {
  const violations = validatePolicyWrite(candidate);
  if (violations.length > 0) {
    throw ErrUtils.validation('Policy write rejected: it would be unloadable or is banned in v1', violations);
  }
}

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
    assertWritablePolicy({ permission: input.permission, effect: input.effect, rule: input.rule ?? {} });
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
      // Validate the MERGED result (patch over the persisted row): partial patches can turn a valid
      // row invalid in ways no single field shows (wildcard row + effect:'allow'; envelope swaps).
      const current = await this.policies.findById(id, t);
      if (!current) throw ErrUtils.notFound('Policy not found');
      assertWritablePolicy({
        permission: input.permission ?? current.permission,
        effect: input.effect ?? current.effect,
        rule: input.rule !== undefined ? input.rule : current.rule,
      });
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
