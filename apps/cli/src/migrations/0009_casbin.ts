import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';

/**
 * Casbin policy store for @aegis/access-control (v2 — SPEC §11.3). Casbin replaces the in-house
 * PDP; policies persist here and are loaded by the enforcer (`createEnforcer`) via
 * casbin-pg-adapter.
 *
 * IMPORTANT — schema is dictated by the adapter. casbin-pg-adapter (the pinned dependency) reads
 * and writes a single table literally named `casbin` with columns `(id serial PK, ptype text,
 * rule jsonb)` and a UNIQUE constraint on `rule` (it stores each policy's fields v0..v5 as a JSONB
 * array in `rule`, NOT as discrete v0..v5 columns). We therefore create exactly that shape so the
 * production adapter works out of the box, plus the adapter's btree indexes on ptype and on the
 * first six rule positions (the v0..v5 fields) for fast filtered policy loads.
 *
 * Policy semantics (model in libs/access-control/src/enforcer.ts):
 *   p-rule:  rule = [sub, dom, act, eft]   — sub=role|userId, dom=tenantId|'*', act=permission
 *   g-rule:  rule = [user, role, dom]      — user has role in tenant domain `dom`
 *
 * This table is global infrastructure (the policy catalog), NOT a tenant-scoped business table, so
 * it carries no tenant_id column and no Row-Level Security: tenant scoping is expressed *inside*
 * each policy via the `dom` field (dom = tenantId), enforced by the Casbin matcher.
 */
const CASBIN_TABLE = 'casbin';

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(CASBIN_TABLE, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ptype: { type: DataTypes.TEXT, allowNull: false },
    rule: { type: DataTypes.JSONB, allowNull: false, unique: 'casbin_uniq_rule' },
  });

  // Adapter's indexes: ptype + each rule position (v0..v5) for filtered policy loads.
  await q.addIndex(CASBIN_TABLE, ['ptype'], { name: 'idx_casbin_ptype', using: 'btree' });
  for (let v = 0; v <= 5; v++) {
    await q.sequelize.query(
      `CREATE INDEX "idx_casbin_rule_v${v}" ON "${CASBIN_TABLE}" USING btree ((rule->>${v}))`,
    );
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(CASBIN_TABLE);
}
