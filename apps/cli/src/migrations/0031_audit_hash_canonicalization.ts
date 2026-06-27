import { QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { computeAuditHash, GENESIS_HASH, type AuditPayload } from '@aegis/audit';
import { TableName } from '@aegis/shared-enums';

interface AuditRow extends AuditPayload {
  id: string;
}

function toPayload(row: AuditRow): AuditPayload {
  return {
    tenant_id: row.tenant_id,
    actor_id: row.actor_id ?? null,
    action: row.action,
    outcome: row.outcome,
    resource_type: row.resource_type ?? null,
    resource_id: row.resource_id ?? null,
    details: row.details ?? {},
    permissions: row.permissions ?? [],
  };
}

async function rewriteCanonicalChains(q: QueryInterface): Promise<void> {
  const rows = await q.sequelize.query<AuditRow>(
    `
      SELECT
        id,
        tenant_id,
        actor_id,
        action,
        outcome,
        resource_type,
        resource_id,
        details,
        permissions
      FROM "${TableName.AuditLog}"
      ORDER BY tenant_id ASC, created_at ASC, id ASC
    `,
    { type: QueryTypes.SELECT },
  );

  let tenantId: string | null = null;
  let prevHash = GENESIS_HASH;

  for (const row of rows) {
    if (row.tenant_id !== tenantId) {
      tenantId = row.tenant_id;
      prevHash = GENESIS_HASH;
    }

    const hash = computeAuditHash(prevHash, toPayload(row));
    await q.sequelize.query(
      `UPDATE "${TableName.AuditLog}" SET prev_hash = $1, hash = $2 WHERE id = $3`,
      { bind: [prevHash, hash, row.id] },
    );
    prevHash = hash;
  }
}

/**
 * Pre-release repair: audit hashes originally used raw JSON.stringify for JSONB details. PostgreSQL
 * can return JSONB object keys in a different order than the app inserted, so legitimate entries
 * with multi-key details could fail verification. The library now canonicalizes nested object keys;
 * this migration rewrites any existing local/demo chains to the same canonical format.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await rewriteCanonicalChains(q);
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await rewriteCanonicalChains(q);
}
