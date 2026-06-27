import { createHash } from 'node:crypto';

export const GENESIS_HASH = 'GENESIS';

/** The fields covered by the tamper-evident hash chain (DB timestamp excluded — precision-safe). */
export interface AuditPayload {
  tenant_id: string;
  actor_id: string | null;
  action: string;
  outcome: string;
  resource_type: string | null;
  resource_id: string | null;
  details: unknown;
  permissions: unknown;
}

/**
 * Each entry's hash depends on the previous entry's hash + a canonical serialization of its fields,
 * so altering any historical entry breaks every subsequent hash (tamper-evidence).
 * See docs/10-auditability-and-compliance.md.
 */
export function computeAuditHash(prevHash: string, payload: AuditPayload): string {
  const canonical = JSON.stringify([
    payload.tenant_id,
    payload.actor_id,
    payload.action,
    payload.outcome,
    payload.resource_type,
    payload.resource_id,
    payload.details,
    payload.permissions,
  ]);
  return createHash('sha256').update(`${prevHash}|${canonical}`).digest('hex');
}
