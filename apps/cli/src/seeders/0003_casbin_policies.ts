import { type QueryInterface, QueryTypes } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';

/**
 * Seed the Casbin policy store (`casbin` table) from the relational role/permission catalog —
 * the single source of truth. Runs AFTER 0001_system_roles + 0002_demo_tenant so the catalog
 * exists. Idempotent: clears prior p/g rules before re-inserting.
 *
 * p-policies  (ptype 'p', rule = [sub, dom, act, eft]) from role_permissions ⋈ permissions ⋈ roles:
 *   sub = role NAME (matches principal.roles carried by the PEP)
 *   dom = '*' for SYSTEM roles (tenant_id IS NULL) so one row serves every tenant;
 *         dom = role.tenant_id for tenant-defined CUSTOM roles
 *   act = permission.name (dotted domain.action)
 *   eft = 'allow'
 *
 * g-policies  (ptype 'g', rule = [user, role, dom]) from user_roles ⋈ roles:
 *   user = user_roles.user_id
 *   role = role NAME
 *   dom  = user_roles.tenant_id (the membership's tenant domain)
 *
 * The adapter stores each rule as a JSONB array in the `rule` column.
 */
const CASBIN_TABLE = 'casbin';

interface PRow {
  role_name: string;
  role_tenant_id: string | null;
  permission_name: string;
}
interface GRow {
  user_id: string;
  role_name: string;
  tenant_id: string;
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const seq = q.sequelize;

  // p-policies: role → permission grants.
  const pRows = await seq.query<PRow>(
    `SELECT r.name AS role_name, r.tenant_id AS role_tenant_id, p.name AS permission_name
       FROM "${TableName.RolePermissions}" rp
       JOIN "${TableName.Roles}" r ON r.id = rp.role_id
       JOIN "${TableName.Permissions}" p ON p.id = rp.permission_id`,
    { type: QueryTypes.SELECT },
  );

  // g-policies: user → role groupings (domain-scoped).
  const gRows = await seq.query<GRow>(
    `SELECT ur.user_id AS user_id, r.name AS role_name, ur.tenant_id AS tenant_id
       FROM "${TableName.UserRoles}" ur
       JOIN "${TableName.Roles}" r ON r.id = ur.role_id`,
    { type: QueryTypes.SELECT },
  );

  const policyRows: Array<{ ptype: string; rule: string[] }> = [];
  const seen = new Set<string>();
  const push = (ptype: string, rule: string[]) => {
    const key = `${ptype}|${rule.join('|')}`;
    if (seen.has(key)) return; // de-dupe against the adapter's UNIQUE(rule) constraint
    seen.add(key);
    policyRows.push({ ptype, rule });
  };

  for (const row of pRows) {
    const dom = row.role_tenant_id ?? '*'; // system roles apply across every tenant domain
    push('p', [row.role_name, dom, row.permission_name, 'allow']);
  }
  for (const row of gRows) {
    push('g', [row.user_id, row.role_name, row.tenant_id]);
  }

  // Idempotent reseed. Insert via raw parameterized SQL with an explicit ::jsonb cast — exactly
  // how casbin-pg-adapter writes rows — so each rule is stored as a JSONB array (not a JSON string).
  await seq.query(`DELETE FROM "${CASBIN_TABLE}"`);
  for (const r of policyRows) {
    await seq.query(`INSERT INTO "${CASBIN_TABLE}" (ptype, rule) VALUES ($1, $2::jsonb)`, {
      bind: [r.ptype, JSON.stringify(r.rule)],
      type: QueryTypes.INSERT,
    });
  }
  console.log(`[seed] casbin policies: ${pRows.length} p-rules, ${gRows.length} g-rules`);
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`DELETE FROM "${CASBIN_TABLE}"`);
}
