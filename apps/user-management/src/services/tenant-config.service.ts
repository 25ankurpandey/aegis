import { inject } from 'inversify';
import { FeatureFlagCache, FeatureFlags, RequestContext } from '@aegis/service-core';
import { AuditAction, AuditOutcome } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
import { withTenantTransaction } from '@aegis/db';
import { AuditLogger } from '@aegis/audit';
import { provideSingleton } from '../ioc/container';
import { TenantConfigRepository } from '../repositories/tenant-config.repository';

/**
 * Optional, additively-gated capabilities. Each is OFF unless its feature flag is explicitly enabled
 * for the tenant (default-off — no row in `tenant_features` means disabled). Wiring a capability here
 * is purely additive: existing behaviour is unchanged when the flag is off.
 */
export const TenantCapabilityFlags = {
  /** Optional Spatial Expenditure Visualizer surface (Feature 36) — advertised only when enabled. */
  ExpenseVisualizer: 'expense.visualizer',
} as const;

/**
 * Tenant-level config + feature-flag administration (multi-tenancy parity — SPEC §11.5).
 * All access is tenant-scoped via withTenantTransaction (RLS). Features are gated by reading
 * a flag's enabled state; settings are arbitrary per-tenant JSON keyed by name.
 */
@provideSingleton(TenantConfigService)
export class TenantConfigService {
  constructor(@inject(TenantConfigRepository) private readonly repo: TenantConfigRepository) {
    // W5-10: front the feature-flag reader with the tenant-scoped read-through cache. Idempotent
    // (no-op if already wrapped) and order-independent: if the DB reader isn't registered yet it just
    // logs and is retried lazily on the first isFeatureEnabled call below.
    FeatureFlagCache.install();
  }

  /** All config entries for the current tenant. */
  async listConfig(): Promise<UserManagementShape.TenantConfigRow[]> {
    return withTenantTransaction((t) => this.repo.listConfig(t));
  }

  /** A single config value for the current tenant (null if unset). */
  async getConfig(key: string): Promise<UserManagementShape.TenantConfigRow | null> {
    return withTenantTransaction((t) => this.repo.getConfig(key, t));
  }

  /** Upsert a per-tenant config value — takes effect immediately. */
  async setConfig(input: UserManagementShape.SetConfigInput): Promise<UserManagementShape.TenantConfigRow> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      const row = await this.repo.setConfig({ tenant_id: tenantId, key: input.key, value: input.value }, t);
      await AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: AuditOutcome.Success,
          resourceType: 'tenant_config',
          resourceId: row.id,
          details: { key: input.key },
        },
        t,
      );
      return row;
    });
  }

  /** All feature flags for the current tenant. */
  async listFeatures(): Promise<UserManagementShape.TenantFeatureRow[]> {
    return withTenantTransaction((t) => this.repo.listFeatures(t));
  }

  /**
   * Whether a feature flag is enabled for the current tenant (defaults to false when unset).
   *
   * W5-10: this no longer opens a fresh `withTenantTransaction` + DB hit on every call. It resolves
   * through {@link FeatureFlags.isEnabledForTenant}, whose reader is fronted by the tenant-scoped
   * read-through {@link FeatureFlagCache} (installed at bootstrap). A repeated check for the same
   * (tenant, flag) is served from cache; `setFlag` invalidates so a toggle takes effect immediately.
   * Fail-soft to `false` is preserved (no context / no reader / lookup error → disabled).
   */
  async isFeatureEnabled(flag: string): Promise<boolean> {
    const tenantId = RequestContext.tenantId();
    // Lazy install retry: covers the case where the DB reader was registered AFTER this singleton was
    // constructed. install() is idempotent, so this is a cheap no-op once the cache is in place.
    FeatureFlagCache.install();
    return FeatureFlags.isEnabledForTenant(tenantId, flag);
  }

  /**
   * The set of optional capabilities currently enabled for this tenant (default-off; SPEC §11.5).
   *
   * This is the one REAL feature gated behind a flag to exercise the cached path end-to-end: the
   * Spatial Expenditure Visualizer (Feature 36) is advertised only when `expense.visualizer` is
   * enabled for the tenant. Additive — when the flag is off the capability is simply absent, leaving
   * all existing behaviour untouched. Each check goes through the read-through {@link FeatureFlagCache}
   * via {@link isFeatureEnabled}, so repeated calls within the TTL avoid a per-call DB round-trip.
   */
  async effectiveCapabilities(): Promise<string[]> {
    const capabilities: string[] = [];
    if (await this.isFeatureEnabled(TenantCapabilityFlags.ExpenseVisualizer)) {
      capabilities.push(TenantCapabilityFlags.ExpenseVisualizer);
    }
    return capabilities;
  }

  /** Enable/disable a feature flag for the current tenant — takes effect immediately. */
  async setFlag(input: UserManagementShape.SetFlagInput): Promise<UserManagementShape.TenantFeatureRow> {
    const tenantId = RequestContext.tenantId();
    const row = await withTenantTransaction(async (t) => {
      const saved = await this.repo.setFeature(
        { tenant_id: tenantId, flag: input.flag, enabled: input.enabled },
        t,
      );
      await AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: AuditOutcome.Success,
          resourceType: 'tenant_feature',
          resourceId: saved.id,
          details: { flag: input.flag, enabled: input.enabled },
        },
        t,
      );
      return saved;
    });
    // W5-10: drop the cached (tenant, flag) entry AFTER the write commits so the next
    // isFeatureEnabled re-reads the new value (the TTL is only a backstop). Fail-soft inside.
    await FeatureFlagCache.invalidate(tenantId, input.flag);
    return row;
  }
}
