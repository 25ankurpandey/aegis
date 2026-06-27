import type { Transaction } from 'sequelize';
import { RequestContext } from '@aegis/service-core';
import { getSequelize } from './connection';
import { setTenantContext } from './rls';

/**
 * Runs `fn` inside a transaction with the tenant RLS context set (from the request context by
 * default). Every tenant-scoped data access should go through this so RLS is always in effect.
 */
export async function withTenantTransaction<T>(
  fn: (t: Transaction) => Promise<T>,
  opts?: { tenantId?: string; userId?: string },
): Promise<T> {
  const sequelize = getSequelize();
  const tenantId = opts?.tenantId ?? RequestContext.tenantId();
  const userId = opts?.userId ?? RequestContext.userId();
  return sequelize.transaction(async (t) => {
    await setTenantContext(sequelize, tenantId, t, userId);
    return fn(t);
  });
}

/** A plain transaction (no tenant context) — for cross-tenant/admin/migration paths only. */
export async function withTransaction<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
  return getSequelize().transaction(fn);
}
