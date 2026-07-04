import { TenantModulesRepository } from './tenant-modules.repository';
import type { TenantModuleEntitlement, UpsertEntitlementInput } from './types';

/** An entitlement grants access iff it is enabled, its status is `active`, and it is not expired. */
function grantsAccess(e: TenantModuleEntitlement, now: Date): boolean {
  if (!e.enabled) return false;
  if (e.status !== 'active') return false;
  if (e.expiresAt !== null && e.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * The per-tenant module entitlement core of the pay-per-module platform. Thin domain wrapper over
 * {@link TenantModulesRepository}: it owns the "does this tenant currently have this module?" rule
 * (enabled AND status active AND not expired) so callers never re-derive it.
 *
 * Every read is RLS-scoped through the repository, so a service instance answers only for its own
 * tenant. Construct with `{ tenantId }` to answer off the request path (workers/tests); on the
 * request path the default ambient RequestContext tenant is used.
 */
export class EntitlementService {
  private readonly repo: TenantModulesRepository;

  constructor(opts: { tenantId?: string; userId?: string } = {}) {
    this.repo = new TenantModulesRepository(opts);
  }

  /** True iff the tenant currently has `moduleId` (enabled, status active, not expired). */
  async isModuleEnabled(moduleId: string, now: Date = new Date()): Promise<boolean> {
    const e = await this.repo.getEntitlement(moduleId);
    return e !== undefined && grantsAccess(e, now);
  }

  /** The module ids the tenant currently has (each satisfying the enabled/active/not-expired rule). */
  async listEnabledModuleIds(now: Date = new Date()): Promise<string[]> {
    const rows = await this.repo.listEnabled();
    return rows.filter((e) => grantsAccess(e, now)).map((e) => e.moduleId);
  }

  /** Create or update the tenant's entitlement for a module. Returns the persisted entitlement. */
  setModuleEntitlement(input: UpsertEntitlementInput): Promise<TenantModuleEntitlement> {
    return this.repo.upsertEntitlement(input);
  }
}
