import { createHash } from 'node:crypto';
import { QueryTypes, Transaction, type Sequelize, type Transaction as Tx } from 'sequelize';
import { getSequelize } from '@aegis/db';
import { RequestContext } from '@aegis/service-core';
import type { AuditAction, AuditOutcome } from '@aegis/shared-enums';
import { getAuditModel } from './audit-log.model';
import { computeAuditHash, GENESIS_HASH, type AuditPayload } from './hash';

export interface AuditInput {
  action: AuditAction;
  outcome: AuditOutcome;
  actorId?: string | null;
  resourceType?: string;
  resourceId?: string;
  details?: unknown;
  permissions?: unknown;
}

/**
 * A stable namespace for the audit-chain advisory locks, keeping them from colliding with advisory
 * locks any other subsystem might take. `pg_advisory_xact_lock(key1, key2)` partitions the lock
 * space by `(key1, key2)`, so a fixed `key1` reserves a private band for audit appends.
 */
const ADVISORY_LOCK_NAMESPACE = 0x41444954; // 'ADIT'

/** Map a tenant id onto a deterministic signed 32-bit advisory-lock key (one lock band per tenant). */
function tenantLockKey(tenantId: string): number {
  // Fold the tenant UUID into 32 bits via SHA-256, then reinterpret as a signed int (pg keys are int4).
  const digest = createHash('sha256').update(tenantId).digest();
  return digest.readInt32BE(0);
}

function toPayload(r: Record<string, unknown>): AuditPayload {
  return {
    tenant_id: r['tenant_id'] as string,
    actor_id: (r['actor_id'] as string) ?? null,
    action: r['action'] as string,
    outcome: r['outcome'] as string,
    resource_type: (r['resource_type'] as string) ?? null,
    resource_id: (r['resource_id'] as string) ?? null,
    details: r['details'],
    permissions: r['permissions'],
  };
}

/**
 * Serialize all audit appends for one tenant by taking a transaction-scoped advisory lock keyed on
 * the tenant. The lock is held until the surrounding transaction commits/rolls back, so the
 * tail-read → hash → insert below is atomic per tenant even when the table is still empty (where a
 * row-level `FOR UPDATE` has no row to grab and two first-writers would otherwise both anchor to
 * GENESIS and fork the chain). A second concurrent writer blocks here until the first commits, then
 * reads the freshly-committed tail.
 */
async function lockTenantChain(sequelize: Sequelize, tenantId: string, t: Tx): Promise<void> {
  await sequelize.query('SELECT pg_advisory_xact_lock($1, $2)', {
    bind: [ADVISORY_LOCK_NAMESPACE, tenantLockKey(tenantId)],
    transaction: t,
    type: QueryTypes.SELECT,
  });
}

/**
 * Append-only, hash-chained audit logger. Each entry captures actor, tenant, action, outcome,
 * resource, details, and the permissions-at-time-of-action. Call within an RLS-scoped transaction.
 */
export const AuditLogger = {
  async record(input: AuditInput, t: Transaction): Promise<void> {
    const Audit = getAuditModel();
    const tenantId = RequestContext.tenantId();

    // Make tail-read + append atomic per tenant. Without this, two parallel writers can both read
    // the same tail, compute the same prev_hash, and fork/duplicate the chain (W1-11).
    await lockTenantChain(getSequelize(), tenantId, t);

    // Lock the current tail row (defense-in-depth once a chain exists). Deterministic tiebreak on
    // `id` keeps the tail well-defined even if two rows share a `created_at` timestamp.
    const last = await Audit.findOne({
      order: [
        ['created_at', 'DESC'],
        ['id', 'DESC'],
      ],
      transaction: t,
      lock: Transaction.LOCK.UPDATE,
    });
    const prevHash = last ? (last.get('hash') as string) : GENESIS_HASH;
    const payload: AuditPayload = {
      tenant_id: tenantId,
      actor_id: input.actorId ?? RequestContext.userId() ?? null,
      action: input.action,
      outcome: input.outcome,
      resource_type: input.resourceType ?? null,
      resource_id: input.resourceId ?? null,
      details: input.details ?? {},
      permissions: input.permissions ?? RequestContext.roles(),
    };
    const hash = computeAuditHash(prevHash, payload);
    await Audit.create({ ...payload, prev_hash: prevHash, hash }, { transaction: t });
  },

  /** Re-walk the tenant's chain and confirm every hash still verifies (tamper detection). */
  async verifyChain(t: Transaction): Promise<{ valid: boolean; brokenAt?: string; count: number }> {
    const Audit = getAuditModel();
    // Re-walk in exact insertion order — same key (and tiebreak) the appender anchors against.
    const rows = await Audit.findAll({
      order: [
        ['created_at', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction: t,
    });
    let prev = GENESIS_HASH;
    for (const row of rows) {
      const r = row.get({ plain: true }) as Record<string, unknown>;
      const expected = computeAuditHash(prev, toPayload(r));
      if (expected !== r['hash'] || prev !== r['prev_hash']) {
        return { valid: false, brokenAt: r['id'] as string, count: rows.length };
      }
      prev = r['hash'] as string;
    }
    return { valid: true, count: rows.length };
  },
};
