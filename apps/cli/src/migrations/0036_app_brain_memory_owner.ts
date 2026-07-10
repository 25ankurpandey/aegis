import type { QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';

// Physical table name (created by 0033). Not in the TableName enum (shared-enums is owned
// elsewhere), so it is referenced as a literal here and in the repository.
const APP_BRAIN = 'app_brain_memory';

/**
 * app_brain_memory owner-scoping + provenance (closes AGENT-03 / MEM-01 / MEM-02 / MEM-03; see
 * docs/strategy/security-findings.md §Recommendations Decision 2 = "both via a scope flag, default
 * private"). Before this migration the store was ONE shared tenant brain: any user in a tenant could
 * recall, supersede, or forgetBySubject another user's memories, with no owner column and no
 * provenance. This adds per-user isolation as an APP-LAYER predicate on top of the existing tenant
 * RLS (exactly like the row-scope pattern elsewhere — RLS stays the tenant guard, the owner predicate
 * narrows within the tenant):
 *
 * - `owner_user_id` UUID NULL          — the owning user. NULL = legacy/tenant-shared row (pre-owner
 *                                        rows stay visible to everyone for back-compat). New writes
 *                                        stamp the acting user.
 * - `memory_scope`  TEXT NOT NULL      — 'private' (default: only the owner + legacy readers see it)
 *                   DEFAULT 'private'    or 'team' (tenant-shared: every user in the tenant sees it).
 * - `created_by`    UUID NULL          — provenance: who first stored the memory (MEM-03).
 * - `updated_by`    UUID NULL          — provenance: who last wrote/superseded/forgot it (MEM-03).
 *
 * RLS is intentionally UNTOUCHED (the 0033 FORCE + RESTRICTIVE tenant policies key on tenant_id and
 * still govern; owner scoping is an app-layer WHERE predicate, matching how row-scope is enforced
 * elsewhere). The partial index accelerates the per-user LIVE read/supersede path within a tenant.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(
    `ALTER TABLE "${APP_BRAIN}"
       ADD COLUMN "owner_user_id" UUID NULL,
       ADD COLUMN "memory_scope" TEXT NOT NULL DEFAULT 'private',
       ADD COLUMN "created_by" UUID NULL,
       ADD COLUMN "updated_by" UUID NULL;`,
  );

  // Per-user LIVE lookup within a tenant: recall/profile/salient and the owner-restricted
  // supersede/forget all filter on (tenant_id, owner_user_id) over live rows. Partial (live only) so
  // the index stays small and matches the `... WHERE valid_to IS NULL` read predicate.
  await q.sequelize.query(
    `CREATE INDEX "app_brain_memory_tenant_owner_live_idx"
       ON "${APP_BRAIN}" (tenant_id, owner_user_id)
       WHERE valid_to IS NULL;`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`DROP INDEX IF EXISTS "app_brain_memory_tenant_owner_live_idx";`);
  await q.sequelize.query(
    `ALTER TABLE "${APP_BRAIN}"
       DROP COLUMN IF EXISTS "updated_by",
       DROP COLUMN IF EXISTS "created_by",
       DROP COLUMN IF EXISTS "memory_scope",
       DROP COLUMN IF EXISTS "owner_user_id";`,
  );
}
