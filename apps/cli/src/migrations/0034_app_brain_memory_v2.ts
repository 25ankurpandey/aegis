import type { QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { HASHING_EMBEDDER_ID } from '@aegis/db';

// Physical table name (created by 0033). Not in the TableName enum (shared-enums is owned
// elsewhere), so it is referenced as a literal here and in the repository.
const APP_BRAIN = 'app_brain_memory';

/**
 * app_brain_memory v2 — the Wayfinder memory semantics, server-side (see ADR-0001's
 * entity/observation + soft-invalidation model; no sync engine — Postgres is authoritative):
 *
 * - `subject`   TEXT NULL              — supersession key: remembering a non-blank subject first
 *                                        soft-invalidates every LIVE same-tenant row with the same
 *                                        trimmed lower(subject), so fresh facts REPLACE stale ones.
 * - `embedder`  TEXT NOT NULL          — vector-SPACE tag of the row's embedding. Defaults to the
 *                                        HashingEmbeddingClient id so all pre-v2 rows (embedded by
 *                                        it before this column existed) are tagged correctly.
 *                                        Recall compares ONLY same-space rows.
 * - `importance` DOUBLE PRECISION NULL — optional salience weight (stored, not yet ranked on).
 * - `valid_to`  TIMESTAMPTZ NULL       — soft-invalidation tombstone: NULL = live; set = superseded
 *                                        or forgotten. Dead rows are kept for audit/history and
 *                                        excluded from every read path.
 *
 * Column adds do not affect the FORCE + RESTRICTIVE RLS policies from 0033 (they key on tenant_id),
 * so RLS is intentionally untouched here. The partial index accelerates the supersede/forget path
 * (find LIVE rows of a tenant by normalized subject).
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(
    `ALTER TABLE "${APP_BRAIN}"
       ADD COLUMN "subject" TEXT NULL,
       ADD COLUMN "embedder" TEXT NOT NULL DEFAULT '${HASHING_EMBEDDER_ID}',
       ADD COLUMN "importance" DOUBLE PRECISION NULL,
       ADD COLUMN "valid_to" TIMESTAMPTZ NULL;`,
  );

  // Supersede lookup: LIVE rows of a tenant by case-normalized subject. Partial (live + subject
  // present) so the index stays small and exactly matches the UPDATE ... WHERE valid_to IS NULL
  // AND lower(subject) = lower($1) predicate used by remember/forgetBySubject.
  await q.sequelize.query(
    `CREATE INDEX "app_brain_memory_tenant_subject_live_idx"
       ON "${APP_BRAIN}" (tenant_id, lower(subject))
       WHERE valid_to IS NULL AND subject IS NOT NULL;`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`DROP INDEX IF EXISTS "app_brain_memory_tenant_subject_live_idx";`);
  await q.sequelize.query(
    `ALTER TABLE "${APP_BRAIN}"
       DROP COLUMN IF EXISTS "valid_to",
       DROP COLUMN IF EXISTS "importance",
       DROP COLUMN IF EXISTS "embedder",
       DROP COLUMN IF EXISTS "subject";`,
  );
}
