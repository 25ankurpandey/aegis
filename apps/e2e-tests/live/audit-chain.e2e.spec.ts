/**
 * Live E2E — tamper-evident audit hash-chain verify (FLOW-093 / FLOWS_v2 audit, E2E tier).
 *
 * There is no public HTTP audit-verify endpoint (verification is the internal AuditLogger.verifyChain,
 * libs/audit/src/audit-logger.ts:101). So this spec re-walks the chain directly against Postgres,
 * replicating the exact hash recipe from libs/audit/src/hash.ts, and asserts every row still verifies.
 *
 * DOUBLE-GATED: runs only when BOTH `E2E_BASE_URL` (to mint audit rows via login) AND
 * `E2E_DATABASE_URL` (a direct Postgres DSN, e.g. the aegis_owner URL) are set. `pg` is required
 * lazily inside the gated block so it is NEVER loaded on the normal mocked `npx jest` path.
 */
import { createHash } from 'node:crypto';
import { describeE2E, login, FIXTURES, e2eEnabled } from './lib/client';

const GENESIS_HASH = 'GENESIS';
const DB_URL = process.env['E2E_DATABASE_URL'] ?? '';
const dbGated = e2eEnabled && DB_URL.length > 0;

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  action: string;
  outcome: string;
  resource_type: string | null;
  resource_id: string | null;
  details: unknown;
  permissions: unknown;
  prev_hash: string;
  hash: string;
}

/** Canonical hash recipe — must stay byte-identical to libs/audit/src/hash.ts:computeAuditHash. */
function computeAuditHash(prevHash: string, r: AuditRow): string {
  const canonical = JSON.stringify([
    r.tenant_id,
    r.actor_id ?? null,
    r.action,
    r.outcome,
    r.resource_type ?? null,
    r.resource_id ?? null,
    r.details,
    r.permissions,
  ]);
  return createHash('sha256').update(`${prevHash}|${canonical}`).digest('hex');
}

(dbGated ? describeE2E : describe.skip)('live: audit hash-chain verify', () => {
  it("re-walks each demo tenant's audit chain and every hash verifies", async () => {
    // 1) Mint at least one fresh audit row per tenant — a successful login records login.succeeded.
    await login(FIXTURES.tenantA);
    await login(FIXTURES.tenantB);

    // 2) Connect directly to Postgres (lazy require keeps `pg` off the mocked-jest path).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg') as typeof import('pg');
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    try {
      for (const tenantId of [FIXTURES.tenantA.id, FIXTURES.tenantB.id]) {
        const { rows } = await client.query<AuditRow>(
          `SELECT id, tenant_id, actor_id, action, outcome, resource_type, resource_id,
                  details, permissions, prev_hash, hash
             FROM audit_log
            WHERE tenant_id = $1
            ORDER BY created_at ASC, id ASC`,
          [tenantId],
        );

        expect(rows.length).toBeGreaterThan(0); // login produced at least one row

        let prev = GENESIS_HASH;
        for (const row of rows) {
          const expected = computeAuditHash(prev, row);
          expect(row.prev_hash).toBe(prev);
          expect(row.hash).toBe(expected);
          prev = row.hash;
        }
      }
    } finally {
      await client.end();
    }
  });
});
