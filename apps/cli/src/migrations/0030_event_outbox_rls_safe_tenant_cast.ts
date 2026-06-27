import { type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { RlsConstants } from '@aegis/shared-constants';
import { TableName } from '@aegis/shared-enums';

const TABLE = TableName.EventOutbox;
const POLICY = `${TABLE}_tenant_isolation`;
const TENANT_SETTING = `NULLIF(current_setting('${RlsConstants.TenantVar}', true), '')::uuid`;
const RELAY_BYPASS = `current_setting('${RlsConstants.OutboxRelayVar}', true) = 'on'`;
const PREDICATE = `((tenant_id = ${TENANT_SETTING}) OR ${RELAY_BYPASS})`;

/**
 * Repair the event_outbox RLS predicate for relay transactions.
 *
 * The relay sets app.outbox_relay='on' and intentionally does not pin one tenant. On some sessions,
 * current_setting('app.current_tenant', true) resolves to an empty string, and casting that to uuid
 * fails before PostgreSQL can evaluate the relay-bypass OR branch. NULLIF makes the tenant side
 * evaluate to NULL instead of throwing while preserving fail-closed behavior for normal sessions.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`DROP POLICY IF EXISTS "${POLICY}" ON "${TABLE}";`);
  await q.sequelize.query(
    `CREATE POLICY "${POLICY}" ON "${TABLE}" AS RESTRICTIVE USING ${PREDICATE} WITH CHECK ${PREDICATE};`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const oldTenantMatch = `(tenant_id = current_setting('${RlsConstants.TenantVar}', true)::uuid)`;
  const oldPredicate = `(${oldTenantMatch} OR ${RELAY_BYPASS})`;
  await q.sequelize.query(`DROP POLICY IF EXISTS "${POLICY}" ON "${TABLE}";`);
  await q.sequelize.query(
    `CREATE POLICY "${POLICY}" ON "${TABLE}" AS RESTRICTIVE USING ${oldPredicate} WITH CHECK ${oldPredicate};`,
  );
}
