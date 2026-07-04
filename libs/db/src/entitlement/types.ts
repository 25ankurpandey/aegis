/**
 * Types for the per-tenant module entitlement core (the `tenant_modules` table). One entitlement
 * row records whether a module is enabled for a tenant, under which plan, its lifecycle status, an
 * optional expiry, and an optional quota bag.
 */

/** Lifecycle status of an entitlement. `active` is the only status that grants access. */
export type EntitlementStatus = 'active' | 'suspended' | 'cancelled' | 'trialing';

/** A `tenant_modules` row as read back from the DB (tenant-scoped via RLS). */
export interface TenantModuleEntitlement {
  id: string;
  tenantId: string;
  moduleId: string;
  enabled: boolean;
  plan: string | null;
  status: string;
  expiresAt: Date | null;
  quota: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Input to create/update a single tenant's entitlement for a module (keyed on moduleId). */
export interface UpsertEntitlementInput {
  moduleId: string;
  enabled: boolean;
  plan?: string | null;
  status?: string;
  expiresAt?: Date | null;
  quota?: Record<string, unknown> | null;
}
