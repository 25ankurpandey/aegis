import { type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';

const POLICY_NAME = 'aegis_app_rls_base';

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function rlsTables(q: QueryInterface): Promise<string[]> {
  const [rows] = await q.sequelize.query(
    `
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relrowsecurity = true
      ORDER BY c.relname
    `,
  );
  return (rows as Array<{ table_name: string }>).map((row) => row.table_name);
}

/**
 * PostgreSQL RLS semantics require at least one permissive policy to admit rows; restrictive
 * policies are then ANDed on top. Earlier migrations created only restrictive tenant policies, which
 * made the non-owner app role see zero rows even when app.current_tenant was set. Add a neutral
 * permissive base policy to every RLS-enabled table; the existing restrictive tenant predicates
 * remain the isolation boundary.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  for (const table of await rlsTables(q)) {
    const quotedTable = quoteIdent(table);
    await q.sequelize.query(`DROP POLICY IF EXISTS ${quoteIdent(POLICY_NAME)} ON ${quotedTable};`);
    await q.sequelize.query(
      `CREATE POLICY ${quoteIdent(POLICY_NAME)} ON ${quotedTable} AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);`,
    );
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  for (const table of await rlsTables(q)) {
    await q.sequelize.query(`DROP POLICY IF EXISTS ${quoteIdent(POLICY_NAME)} ON ${quoteIdent(table)};`);
  }
}
