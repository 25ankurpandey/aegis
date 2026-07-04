import { QueryTypes, type Transaction } from 'sequelize';
import { getSequelize } from '../connection';
import { withTenantTransaction } from '../transaction';
import type { TenantModuleEntitlement, UpsertEntitlementInput } from './types';

/** Physical table name (see migration 0032 — not yet in the shared TableName enum). */
const TENANT_MODULES = 'tenant_modules';

/** The raw column shape returned by the DB (snake_case), mapped to the domain type below. */
interface TenantModuleRow {
  id: string;
  tenant_id: string;
  module_id: string;
  enabled: boolean;
  plan: string | null;
  status: string;
  expires_at: Date | string | null;
  quota: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toEntitlement(row: TenantModuleRow): TenantModuleEntitlement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    moduleId: row.module_id,
    enabled: row.enabled,
    plan: row.plan,
    status: row.status,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    quota: row.quota,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Repository for the `tenant_modules` entitlement table. Every method runs inside
 * {@link withTenantTransaction} so the RLS context (`app.current_tenant`) is set: reads only ever
 * see the current tenant's rows and writes are constrained by the RESTRICTIVE policy's WITH CHECK to
 * the current tenant. `opts.tenantId` lets off-request callers (workers, tests) pin the tenant
 * explicitly; on the request path it defaults to the ambient RequestContext tenant.
 */
export class TenantModulesRepository {
  constructor(private readonly opts: { tenantId?: string; userId?: string } = {}) {}

  private run<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
    return withTenantTransaction(fn, this.opts);
  }

  /** The tenant's entitlement for a single module, or `undefined` if none exists. */
  getEntitlement(moduleId: string): Promise<TenantModuleEntitlement | undefined> {
    return this.run(async (t) => {
      const rows = await getSequelize().query<TenantModuleRow>(
        `SELECT id, tenant_id, module_id, enabled, plan, status, expires_at, quota, created_at, updated_at
           FROM "${TENANT_MODULES}"
          WHERE module_id = $1
          LIMIT 1`,
        { bind: [moduleId], type: QueryTypes.SELECT, transaction: t },
      );
      return rows.length > 0 ? toEntitlement(rows[0]) : undefined;
    });
  }

  /** Every enabled entitlement row for the tenant (regardless of status/expiry — the service filters). */
  listEnabled(): Promise<TenantModuleEntitlement[]> {
    return this.run(async (t) => {
      const rows = await getSequelize().query<TenantModuleRow>(
        `SELECT id, tenant_id, module_id, enabled, plan, status, expires_at, quota, created_at, updated_at
           FROM "${TENANT_MODULES}"
          WHERE enabled = true
          ORDER BY module_id`,
        { type: QueryTypes.SELECT, transaction: t },
      );
      return rows.map(toEntitlement);
    });
  }

  /**
   * Create or update the tenant's entitlement for `input.moduleId` (idempotent on the
   * (tenant_id, module_id) unique index). `tenant_id` is taken from the RLS session setting so it
   * always matches the policy's WITH CHECK. Returns the persisted row.
   */
  upsertEntitlement(input: UpsertEntitlementInput): Promise<TenantModuleEntitlement> {
    return this.run(async (t) => {
      const rows = await getSequelize().query<TenantModuleRow>(
        `INSERT INTO "${TENANT_MODULES}"
           (tenant_id, module_id, enabled, plan, status, expires_at, quota, created_at, updated_at)
         VALUES
           (current_setting('app.current_tenant', true)::uuid, $1, $2, $3, $4, $5, $6::jsonb, now(), now())
         ON CONFLICT (tenant_id, module_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           plan = EXCLUDED.plan,
           status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           quota = EXCLUDED.quota,
           updated_at = now()
         RETURNING id, tenant_id, module_id, enabled, plan, status, expires_at, quota, created_at, updated_at`,
        {
          bind: [
            input.moduleId,
            input.enabled,
            input.plan ?? null,
            input.status ?? 'active',
            input.expiresAt ?? null,
            input.quota === undefined || input.quota === null ? null : JSON.stringify(input.quota),
          ],
          type: QueryTypes.SELECT,
          transaction: t,
        },
      );
      return toEntitlement(rows[0]);
    });
  }
}
