import { type Sequelize, type Transaction, QueryTypes } from 'sequelize';
import { RlsConstants } from '@aegis/shared-constants';

/**
 * Sets the tenant (and optional user) context for Row-Level Security, scoped to the current
 * transaction. CRITICAL: uses set_config(..., true) — the `true` makes it transaction-LOCAL
 * (the SET LOCAL equivalent), which is safe under transaction-mode connection pooling.
 */
export async function setTenantContext(
  sequelize: Sequelize,
  tenantId: string,
  transaction: Transaction,
  userId?: string,
): Promise<void> {
  await sequelize.query('SELECT set_config($1, $2, true)', {
    bind: [RlsConstants.TenantVar, tenantId],
    transaction,
    type: QueryTypes.SELECT,
  });
  if (userId) {
    await sequelize.query('SELECT set_config($1, $2, true)', {
      bind: [RlsConstants.UserVar, userId],
      transaction,
      type: QueryTypes.SELECT,
    });
  }
}

/**
 * SQL statements to enable strict tenant isolation on a table. Run from a migration AFTER the
 * table is created. RESTRICTIVE so the tenant guard cannot be OR'd away by a permissive policy.
 *
 * By default the WRITE predicate (WITH CHECK) equals the READ predicate (USING): a row is readable
 * and writable exactly when its `tenant_id` matches the session tenant. Pass `opts.withCheck` to set
 * a DISTINCT, stricter write predicate when a table's USING intentionally admits rows a tenant
 * session must be able to READ but not WRITE (e.g. global system rows — see BUG-0009).
 */
export function rlsPolicyStatements(table: string, opts: { withCheck?: string } = {}): string[] {
  const policy = `${table}_tenant_isolation`;
  const basePolicy = `${table}_app_access`;
  const predicate = `(tenant_id = current_setting('${RlsConstants.TenantVar}', true)::uuid)`;
  const check = opts.withCheck ? `(${opts.withCheck})` : predicate;
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
    // PostgreSQL combines permissive policies with OR, then restrictive policies with AND. A table
    // with only restrictive policies denies every row, so each tenant-scoped table needs this neutral
    // permissive base; the restrictive tenant policy below remains the actual isolation guard.
    `DROP POLICY IF EXISTS "${basePolicy}" ON "${table}";`,
    `CREATE POLICY "${basePolicy}" ON "${table}" AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);`,
    `DROP POLICY IF EXISTS "${policy}" ON "${table}";`,
    `CREATE POLICY "${policy}" ON "${table}" AS RESTRICTIVE USING ${predicate} WITH CHECK ${check};`,
  ];
}
