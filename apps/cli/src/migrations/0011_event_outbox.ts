import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { RlsConstants } from '@aegis/shared-constants';

/**
 * Transactional outbox (W2-06). Domain events are staged into `event_outbox` INSIDE the same
 * tenant-scoped transaction as the business write, so the event is persisted ATOMICALLY with the
 * write — no dual-write window where a crash between commit and publish loses the event. A relay
 * (worker / dedicated PROCESS_TYPE=relay) later drains pending rows to the bus at-least-once and
 * marks them published.
 *
 * RLS: FORCE + RESTRICTIVE keyed on app.current_tenant, EXACTLY like every other tenant-scoped table,
 * so a staged event can never leak across tenants on the producer path. The single addition is an
 * OR-clause for the relay: when the relay's transaction sets `app.outbox_relay = 'on'` (SET LOCAL,
 * transaction-local), the policy admits rows for ALL tenants so one poll can drain every tenant's
 * backlog. Normal tenant sessions never set that var, so they keep strict per-tenant isolation.
 */

const RELAY_BYPASS = `current_setting('${RlsConstants.OutboxRelayVar}', true) = 'on'`;
const TENANT_SETTING = `NULLIF(current_setting('${RlsConstants.TenantVar}', true), '')::uuid`;
const TENANT_MATCH = `(tenant_id = ${TENANT_SETTING})`;
const PREDICATE = `(${TENANT_MATCH} OR ${RELAY_BYPASS})`;

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TableName.EventOutbox, {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    topic: { type: DataTypes.STRING, allowNull: false },
    payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    // The full EventEnvelope (id, correlationId, sourceService, occurredAt, …) captured at stage time,
    // so the relay republishes the exact envelope the producer authored — context intact for consumers.
    envelope: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_error: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    published_at: { type: DataTypes.DATE, allowNull: true },
  });

  // Relay poll: pending rows oldest-first. Partial index keeps it tight as published rows accumulate.
  await q.sequelize.query(
    `CREATE INDEX "event_outbox_status_created_idx" ON "${TableName.EventOutbox}" (status, created_at) WHERE status = 'pending';`,
  );

  // Row-Level Security: FORCE + RESTRICTIVE on tenant_id, with the relay-bypass OR-clause.
  const policy = `${TableName.EventOutbox}_tenant_isolation`;
  const stmts = [
    `ALTER TABLE "${TableName.EventOutbox}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${TableName.EventOutbox}" FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "${policy}" ON "${TableName.EventOutbox}";`,
    `CREATE POLICY "${policy}" ON "${TableName.EventOutbox}" AS RESTRICTIVE USING ${PREDICATE} WITH CHECK ${PREDICATE};`,
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.EventOutbox);
}
