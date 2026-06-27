import { randomUUID as uuid } from 'node:crypto';
import { type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { ConnectorKind, TableName } from '@aegis/shared-enums';

const TENANT_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];

function rowsForTenant(tenantId: string, now: Date): Array<Record<string, unknown>> {
  return Object.values(ConnectorKind).map((kind) => ({
    id: uuid(),
    tenant_id: tenantId,
    kind,
    active: kind === ConnectorKind.LedgerOne,
    base_url: `https://mock-connectors.aegis.local/${kind}`,
    credentials_ref: `/aegis/demo/connectors/${kind}`,
    settings: JSON.stringify({ mode: 'mock' }),
    created_by: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
  }));
}

/** Seed neutral mock ERP connector configs for the demo tenants. */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const now = new Date();
  for (const tenantId of TENANT_IDS) {
    await q.sequelize.query(`SELECT set_config('app.current_tenant', '${tenantId}', false)`);
    await q.bulkDelete(TableName.ConnectorConfigs, { tenant_id: tenantId });
    await q.bulkInsert(TableName.ConnectorConfigs, rowsForTenant(tenantId, now));
  }
  console.log('[seed] connector configs: neutral mock connectors for demo tenants');
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  for (const tenantId of TENANT_IDS) {
    await q.sequelize.query(`SELECT set_config('app.current_tenant', '${tenantId}', false)`);
    await q.bulkDelete(TableName.ConnectorConfigs, { tenant_id: tenantId });
  }
}
