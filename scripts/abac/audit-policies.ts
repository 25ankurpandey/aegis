/**
 * ONE-TIME READ-ONLY AUDIT of persisted ABAC `policies` rows (ABAC generalization Phase 0 —
 * docs/strategy/abac-generalization.md §3 Q2, §5 Phase 0).
 *
 * The write-time PAP validator only protects NEW writes; rows persisted before the hardening may
 * violate the v1 rule envelope (unknown permissions, wildcard allows, `scope` keys, malformed
 * conditions/`$attr` refs). Under the all-or-nothing load contract (§3 Q1/Q8) ONE such active row
 * will block every request for its (tenant, action) the moment Phase 1 wires `dbPolicies` — so this
 * script runs every row through the exact load-time mapper and reports what would fail, BEFORE any
 * route is wired. Fix or deactivate offenders by hand; never silently filter them at load.
 *
 * Read-only: SELECT only, no writes, exits 0 (findings are informational, not a script failure).
 *
 * HOW TO RUN (from the repo root; the repo has only tsconfig.base.json, so ts-node needs both the
 * project file and tsconfig-paths for the @aegis/* aliases the mapper imports):
 *
 *   TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
 *     node -r ts-node/register -r tsconfig-paths/register scripts/abac/audit-policies.ts
 *
 * Connection: `DATABASE_URL`, defaulting to the local dev owner DSN
 * (postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis). The `policies` table is under
 * FORCE ROW LEVEL SECURITY with a tenant-GUC predicate (libs/db/src/rls.ts), which hides every row
 * from a session that sets no tenant — the audit is cross-tenant by design, so it issues
 * `SET row_security = off` (honored for the table OWNER, which aegis_owner is). If that SET is
 * rejected for a non-owner role the script warns and the report may be empty/partial.
 */

import { mapPolicyRow, type PolicyRow } from '../../libs/access-control/src/policy-row-mapper';

// `pg` ships no bundled TS types and @types/pg is not a devDependency (no new npm deps in Phase 0);
// require + a minimal structural type keeps this script self-contained under TRANSPILE_ONLY ts-node.
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg') as { Client: new (cfg: { connectionString: string }) => PgClient };

const DEFAULT_DATABASE_URL = 'postgres://aegis_owner:aegis_local@127.0.0.1:55432/aegis';

interface AuditRow extends PolicyRow {
  deleted?: boolean;
}

async function fetchRows(client: PgClient): Promise<AuditRow[]> {
  // Soft-deleted rows are excluded: the paranoid model never surfaces them to the loader either.
  const { rows } = await client.query(
    `SELECT id, tenant_id, permission, effect, rule, priority, is_active
       FROM policies
      WHERE deleted_at IS NULL
      ORDER BY tenant_id ASC, priority ASC, id ASC`,
  );
  return rows as unknown as AuditRow[];
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();

  try {
    try {
      await client.query('SET row_security = off');
    } catch (err) {
      console.warn(
        `WARN: could not SET row_security = off (${(err as Error).message}); ` +
          'connected role is not the table owner — RLS may hide rows and the audit may be incomplete.',
      );
    }

    const rows = await fetchRows(client);

    let valid = 0;
    const activeErrors: Array<{ row: AuditRow; reason: string }> = [];
    const inactiveErrors: Array<{ row: AuditRow; reason: string }> = [];
    const warnings: Array<{ row: AuditRow; message: string }> = [];

    for (const row of rows) {
      const result = mapPolicyRow(row);
      if (result.ok) {
        valid += 1;
        if (result.warning) warnings.push({ row, message: result.warning });
      } else if (row.is_active) {
        activeErrors.push({ row, reason: result.error.reason });
      } else {
        inactiveErrors.push({ row, reason: result.error.reason });
      }
    }

    const activeCount = rows.filter((r) => r.is_active).length;
    const describe = (r: AuditRow) => `${r.id} [tenant ${r.tenant_id}] permission='${r.permission}' effect='${r.effect}'`;

    console.log('ABAC policies audit (read-only) — load-time mapper applied to every persisted row');
    console.log('================================================================================');
    console.log(`database          : ${connectionString.replace(/\/\/[^@]*@/, '//<redacted>@')}`);
    console.log(`total rows        : ${rows.length} (${activeCount} active, ${rows.length - activeCount} inactive)`);
    console.log(`valid             : ${valid}`);
    console.log(`LOAD-BLOCKING     : ${activeErrors.length} (active rows the all-or-nothing load will refuse)`);
    console.log(`inactive-invalid  : ${inactiveErrors.length} (would block only if reactivated)`);
    console.log(`warnings          : ${warnings.length}`);
    console.log('');

    if (activeErrors.length > 0) {
      console.log('LOAD-BLOCKING rows — fix or deactivate BEFORE Phase 1 wires any route:');
      for (const { row, reason } of activeErrors) console.log(`  - ${describe(row)}\n      ${reason}`);
      console.log('');
    }
    if (inactiveErrors.length > 0) {
      console.log('Inactive rows that would fail the load if reactivated:');
      for (const { row, reason } of inactiveErrors) console.log(`  - ${describe(row)}\n      ${reason}`);
      console.log('');
    }
    if (warnings.length > 0) {
      console.log('Advisories:');
      for (const { row, message } of warnings) console.log(`  - ${describe(row)}\n      ${message}`);
      console.log('');
    }

    console.log(
      activeErrors.length === 0
        ? 'RESULT: every active row is loadable under the v1 envelope. Safe to proceed to Phase 1.'
        : `RESULT: ${activeErrors.length} active row(s) MUST be fixed or deactivated before Phase 1.`,
    );
  } finally {
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Audit failed to run (no report produced):', err);
    process.exit(1);
  });
