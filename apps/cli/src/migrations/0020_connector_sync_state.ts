import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { RlsConstants } from '@aegis/shared-constants';

/**
 * DURABLE CONNECTOR SYNC-STATE (ERP_proxy_alignment §4 items 1, 3, 6).
 *
 * BaseConnector previously kept idempotency in a PROCESS-LOCAL `Map`, so across worker restarts,
 * multiple workflow replicas, or a Kafka rebalance the same invoice/pay-run could re-push to a real
 * ERP under at-least-once delivery — the single most important production gap in the analysis. This
 * table makes the push outcome durable: one row per (tenant, idempotency_key) records the lifecycle
 * status, the ERP external id, attempt count, and last error. It is the Aegis equivalent of the donor's
 * `SyncRecords`/`SyncStatuses` + advisory-lock dedupe, and the queryable seam the
 * scheduled reconcile / connector-sync consumer uses to advance a `queued`/`in_progress` row toward a
 * terminal status (the donor's status-poll cron).
 *
 * Idempotency is enforced by a tenant-scoped UNIQUE index on (tenant_id, idempotency_key): a concurrent
 * redelivery loses the insert race and the store reads the winner's row instead of double-pushing.
 *
 * RLS: FORCE + RESTRICTIVE on tenant_id — identical to every other tenant-scoped table — so a sync-state
 * row can never leak across tenants. A reconcile job runs inside `withTenantTransaction`, so it reads
 * only its own tenant's reconcilable rows.
 */

const TABLE = TableName.ConnectorSyncState;
const TENANT_MATCH = `(tenant_id = current_setting('${RlsConstants.TenantVar}', true)::uuid)`;

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TABLE, {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    // The ConnectorKind (ledger_one / finovo / acct_bridge / …) the push targets.
    kind: { type: DataTypes.STRING, allowNull: false },
    // The ConnectorEntity (invoice / expense / payroll_journal).
    entity: { type: DataTypes.STRING, allowNull: false },
    // The producer-stable business id (invoice id / `runId:hash`) — for operator lookup; NOT unique.
    record_id: { type: DataTypes.STRING, allowNull: false },
    // UNIQUE per tenant — the durable idempotency key (at most one push per key).
    idempotency_key: { type: DataTypes.STRING, allowNull: false },
    // Lifecycle: synced | queued | in_progress | error (ConnectorSyncStatus).
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'in_progress' },
    // The id the ERP assigned to the pushed record (used by the reconcile status-poll).
    external_id: { type: DataTypes.STRING, allowNull: true },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_error: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  });

  // Durable idempotency: at most one row per (tenant, idempotency_key). The loser of a concurrent
  // redelivery hits 23505 and the store falls back to reading the existing row (no double-push).
  await q.sequelize.query(
    `CREATE UNIQUE INDEX "connector_sync_state_tenant_idem_uq" ON "${TABLE}" ("tenant_id", "idempotency_key");`,
  );

  // Reconcile poll: non-terminal rows oldest-first. Partial index keeps it tight as terminal rows
  // (synced/error) accumulate.
  await q.sequelize.query(
    `CREATE INDEX "connector_sync_state_reconcile_idx" ON "${TABLE}" (tenant_id, created_at) ` +
      `WHERE status IN ('queued', 'in_progress');`,
  );

  // Row-Level Security: FORCE + RESTRICTIVE on tenant_id, matching every tenant-scoped table.
  const policy = `${TABLE}_tenant_isolation`;
  const stmts = [
    `ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "${policy}" ON "${TABLE}";`,
    `CREATE POLICY "${policy}" ON "${TABLE}" AS RESTRICTIVE USING ${TENANT_MATCH} WITH CHECK ${TENANT_MATCH};`,
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TABLE);
}
