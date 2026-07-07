import { QueryTypes, type Transaction } from 'sequelize';
import { getSequelize } from '../connection';
import { withTenantTransaction } from '../transaction';
import { HASHING_EMBEDDER_ID } from './embedding-client';
import type { AppBrainMemory, RecallHit, RememberInput } from './types';

/** Physical table name (see migrations 0033/0034 — not in the shared TableName enum). */
const APP_BRAIN = 'app_brain_memory';

/** The scalar columns every read selects (the embedding column is never mapped back). */
const SCALAR_COLUMNS =
  'id, tenant_id, kind, ref, subject, title, content, metadata, embedder, importance, valid_to, created_at, updated_at';

/** The raw scalar column shape returned by the DB (snake_case); the embedding is never selected. */
interface AppBrainRow {
  id: string;
  tenant_id: string;
  kind: string;
  ref: string | null;
  subject: string | null;
  title: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  embedder: string;
  importance: number | string | null;
  valid_to: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toMemory(row: AppBrainRow): AppBrainMemory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    ref: row.ref,
    subject: row.subject,
    title: row.title,
    content: row.content,
    metadata: row.metadata,
    embedder: row.embedder,
    importance: row.importance === null || row.importance === undefined ? null : Number(row.importance),
    validTo: row.valid_to === null || row.valid_to === undefined ? null : new Date(row.valid_to),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** Render a numeric vector as a pgvector text literal — `[1,2,3]` — for a `$N::vector` bind. */
function formatVector(arr: number[]): string {
  return `[${arr.join(',')}]`;
}

/**
 * Normalize a supersession subject: trimmed, blank → null (a blank subject supersedes/matches
 * NOTHING — subject-less facts never collide). Case is preserved for storage; matching lowers both
 * sides in SQL.
 */
function normalizeSubject(subject: string | null | undefined): string | null {
  const trimmed = (subject ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Repository for the `app_brain_memory` semantic-memory table. Every method runs inside
 * {@link withTenantTransaction} so the RLS context (`app.current_tenant`) is set: reads only ever
 * see the current tenant's rows and writes are constrained by the RESTRICTIVE policy's WITH CHECK to
 * the current tenant. `opts.tenantId` lets off-request callers (workers, tests) pin the tenant
 * explicitly; on the request path it defaults to the ambient RequestContext tenant.
 *
 * v2 (Wayfinder memory semantics, migration 0034): rows carry a `subject` supersession key, an
 * `embedder` vector-space tag, an optional `importance`, and a soft-invalidation `valid_to`
 * tombstone. Reads see LIVE rows only (`valid_to IS NULL`); dead rows are kept for audit/history.
 */
export class AppBrainRepository {
  constructor(private readonly opts: { tenantId?: string; userId?: string } = {}) {}

  private run<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
    return withTenantTransaction(fn, this.opts);
  }

  /**
   * Store a memory with its precomputed `embedding` (tagged with `embedderId` — the vector space it
   * was produced in). `tenant_id` comes from the RLS session setting so it always matches the
   * policy's WITH CHECK.
   *
   * SUPERSEDE-BY-SUBJECT (same transaction, before the insert): when `input.subject` is non-blank,
   * every LIVE row of this tenant with the same trimmed lower(subject) is soft-invalidated
   * (`valid_to = now()`) so the fresh fact REPLACES the stale one instead of accumulating next to it.
   *
   * When `input.ref` is non-null the write upserts on the partial unique `(tenant_id, kind, ref)`
   * index (which spans dead rows too — the slot is per (tenant, kind, ref) forever), and the upsert
   * REVIVES a soft-invalidated row (`valid_to = NULL`) with the fresh content/embedding. When `ref`
   * is null every call inserts a new row. Returns the mapped row (scalar columns only).
   */
  remember(
    input: RememberInput,
    embedding: number[],
    embedderId: string = HASHING_EMBEDDER_ID,
  ): Promise<AppBrainMemory> {
    const metadata =
      input.metadata === undefined || input.metadata === null ? null : JSON.stringify(input.metadata);
    const subject = normalizeSubject(input.subject);
    return this.run(async (t) => {
      if (subject !== null) {
        // Soft-invalidate every live same-subject row first (RLS scopes this to the tenant). The
        // insert below runs in the SAME transaction, so supersede+insert is atomic.
        await getSequelize().query(
          `UPDATE "${APP_BRAIN}"
              SET valid_to = now(), updated_at = now()
            WHERE valid_to IS NULL AND subject IS NOT NULL AND lower(subject) = lower($1)`,
          { bind: [subject], type: QueryTypes.UPDATE, transaction: t },
        );
      }
      const rows = await getSequelize().query<AppBrainRow>(
        `INSERT INTO "${APP_BRAIN}"
           (tenant_id, kind, ref, subject, title, content, metadata, importance, embedding, embedder, created_at, updated_at)
         VALUES
           (current_setting('app.current_tenant', true)::uuid, $1, $2, $3, $4, $5, $6::jsonb, $7, $8::vector, $9, now(), now())
         ON CONFLICT (tenant_id, kind, ref) WHERE ref IS NOT NULL DO UPDATE SET
           subject = EXCLUDED.subject,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           importance = EXCLUDED.importance,
           embedding = EXCLUDED.embedding,
           embedder = EXCLUDED.embedder,
           valid_to = NULL,
           updated_at = now()
         RETURNING ${SCALAR_COLUMNS}`,
        {
          bind: [
            input.kind,
            input.ref ?? null,
            subject,
            input.title ?? null,
            input.content,
            metadata,
            input.importance ?? null,
            formatVector(embedding),
            embedderId,
          ],
          type: QueryTypes.SELECT,
          transaction: t,
        },
      );
      return toMemory(rows[0]);
    });
  }

  /**
   * The `k` nearest LIVE memories to `embedding` by cosine distance (the `<=>` operator, matching
   * the `vector_cosine_ops` HNSW index), optionally filtered to a single `kind`. Rows are
   * RLS-scoped to the current tenant.
   *
   * - `opts.embedderId` restricts the ranking to rows in the SAME vector space (rows embedded by a
   *   different model/version are IGNORED, never mixed in). The service always passes it.
   * - `opts.minScore` is a cosine SIMILARITY floor in [0, 1], applied as `distance <= 1 - minScore`
   *   (pgvector's `<=>` is cosine DISTANCE = 1 - similarity) — drops weak hits.
   *
   * Returns each mapped memory plus its `distance` (smaller = more similar).
   */
  searchSimilar(
    embedding: number[],
    k: number,
    opts?: { kind?: string; minScore?: number; embedderId?: string },
  ): Promise<RecallHit[]> {
    const literal = formatVector(embedding);
    return this.run(async (t) => {
      const bind: unknown[] = [literal];
      const where: string[] = ['valid_to IS NULL'];
      if (opts?.embedderId !== undefined) {
        bind.push(opts.embedderId);
        where.push(`embedder = $${bind.length}`);
      }
      if (opts?.kind !== undefined) {
        bind.push(opts.kind);
        where.push(`kind = $${bind.length}`);
      }
      if (opts?.minScore !== undefined) {
        bind.push(1 - opts.minScore);
        where.push(`(embedding <=> $1::vector) <= $${bind.length}`);
      }
      bind.push(k);
      const limitParam = `$${bind.length}`;
      const rows = await getSequelize().query<AppBrainRow & { distance: number }>(
        `SELECT ${SCALAR_COLUMNS},
                embedding <=> $1::vector AS distance
           FROM "${APP_BRAIN}"
          WHERE ${where.join(' AND ')}
          ORDER BY embedding <=> $1::vector
          LIMIT ${limitParam}`,
        { bind, type: QueryTypes.SELECT, transaction: t },
      );
      return rows.map((row) => ({ ...toMemory(row), distance: Number(row.distance) }));
    });
  }

  /**
   * Soft-invalidate ONE live row by id (`valid_to = now()`) — the row is kept for audit/history but
   * leaves every read path. Returns true when a live row was invalidated; false when the id does
   * not exist, belongs to another tenant (RLS), or was already dead.
   */
  invalidateById(id: string): Promise<boolean> {
    return this.run(async (t) => {
      const rows = await getSequelize().query<{ id: string }>(
        `UPDATE "${APP_BRAIN}"
            SET valid_to = now(), updated_at = now()
          WHERE id = $1::uuid AND valid_to IS NULL
          RETURNING id`,
        { bind: [id], type: QueryTypes.SELECT, transaction: t },
      );
      return rows.length > 0;
    });
  }

  /**
   * Soft-invalidate EVERY live row of the current tenant whose trimmed lower(subject) matches.
   * A blank subject invalidates nothing (returns 0). Returns the number of rows invalidated.
   */
  invalidateBySubject(subject: string): Promise<number> {
    const normalized = normalizeSubject(subject);
    if (normalized === null) return Promise.resolve(0);
    return this.run(async (t) => {
      const rows = await getSequelize().query<{ id: string }>(
        `UPDATE "${APP_BRAIN}"
            SET valid_to = now(), updated_at = now()
          WHERE valid_to IS NULL AND subject IS NOT NULL AND lower(subject) = lower($1)
          RETURNING id`,
        { bind: [normalized], type: QueryTypes.SELECT, transaction: t },
      );
      return rows.length;
    });
  }

  /** LIVE rows of one `kind`, most recently updated first (deterministic tie-break), capped at `limit`. */
  listByKind(kind: string, limit: number): Promise<AppBrainMemory[]> {
    return this.run(async (t) => {
      const rows = await getSequelize().query<AppBrainRow>(
        `SELECT ${SCALAR_COLUMNS}
           FROM "${APP_BRAIN}"
          WHERE valid_to IS NULL AND kind = $1
          ORDER BY updated_at DESC, created_at DESC, id ASC
          LIMIT $2`,
        { bind: [kind, limit], type: QueryTypes.SELECT, transaction: t },
      );
      return rows.map(toMemory);
    });
  }

  /** LIVE rows of ANY kind, most recently updated first (deterministic tie-break), capped at `limit`. */
  listRecent(limit: number): Promise<AppBrainMemory[]> {
    return this.run(async (t) => {
      const rows = await getSequelize().query<AppBrainRow>(
        `SELECT ${SCALAR_COLUMNS}
           FROM "${APP_BRAIN}"
          WHERE valid_to IS NULL
          ORDER BY updated_at DESC, created_at DESC, id ASC
          LIMIT $1`,
        { bind: [limit], type: QueryTypes.SELECT, transaction: t },
      );
      return rows.map(toMemory);
    });
  }

  /** Delete every memory matching (current tenant, `kind`, `ref`). Returns the number deleted. */
  deleteByRef(kind: string, ref: string): Promise<number> {
    return this.run(async (t) => {
      // RETURNING + row count is stable across Sequelize versions on postgres (the affected-count
      // element of the DELETE tuple is not); RLS still scopes the delete to the current tenant.
      const rows = await getSequelize().query<{ id: string }>(
        `DELETE FROM "${APP_BRAIN}" WHERE kind = $1 AND ref = $2 RETURNING id`,
        { bind: [kind, ref], type: QueryTypes.SELECT, transaction: t },
      );
      return rows.length;
    });
  }
}
