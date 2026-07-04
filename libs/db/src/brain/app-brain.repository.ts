import { QueryTypes, type Transaction } from 'sequelize';
import { getSequelize } from '../connection';
import { withTenantTransaction } from '../transaction';
import type { AppBrainMemory, RecallHit, RememberInput } from './types';

/** Physical table name (see migration 0033 — not in the shared TableName enum). */
const APP_BRAIN = 'app_brain_memory';

/** The raw scalar column shape returned by the DB (snake_case); the embedding is never selected. */
interface AppBrainRow {
  id: string;
  tenant_id: string;
  kind: string;
  ref: string | null;
  title: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toMemory(row: AppBrainRow): AppBrainMemory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    ref: row.ref,
    title: row.title,
    content: row.content,
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** Render a numeric vector as a pgvector text literal — `[1,2,3]` — for a `$N::vector` bind. */
function formatVector(arr: number[]): string {
  return `[${arr.join(',')}]`;
}

/**
 * Repository for the `app_brain_memory` semantic-memory table. Every method runs inside
 * {@link withTenantTransaction} so the RLS context (`app.current_tenant`) is set: reads only ever
 * see the current tenant's rows and writes are constrained by the RESTRICTIVE policy's WITH CHECK to
 * the current tenant. `opts.tenantId` lets off-request callers (workers, tests) pin the tenant
 * explicitly; on the request path it defaults to the ambient RequestContext tenant.
 */
export class AppBrainRepository {
  constructor(private readonly opts: { tenantId?: string; userId?: string } = {}) {}

  private run<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
    return withTenantTransaction(fn, this.opts);
  }

  /**
   * Store a memory with its precomputed `embedding`. `tenant_id` comes from the RLS session setting
   * so it always matches the policy's WITH CHECK. When `input.ref` is non-null the write upserts on
   * the partial unique `(tenant_id, kind, ref)` index; when `ref` is null every call inserts a new
   * row. The embedding is bound as a pgvector literal and cast `$N::vector`. Returns the mapped row
   * (scalar columns only — the embedding column is not selected back).
   */
  remember(input: RememberInput, embedding: number[]): Promise<AppBrainMemory> {
    const metadata =
      input.metadata === undefined || input.metadata === null ? null : JSON.stringify(input.metadata);
    return this.run(async (t) => {
      const rows = await getSequelize().query<AppBrainRow>(
        `INSERT INTO "${APP_BRAIN}"
           (tenant_id, kind, ref, title, content, metadata, embedding, created_at, updated_at)
         VALUES
           (current_setting('app.current_tenant', true)::uuid, $1, $2, $3, $4, $5::jsonb, $6::vector, now(), now())
         ON CONFLICT (tenant_id, kind, ref) WHERE ref IS NOT NULL DO UPDATE SET
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding,
           updated_at = now()
         RETURNING id, tenant_id, kind, ref, title, content, metadata, created_at, updated_at`,
        {
          bind: [
            input.kind,
            input.ref ?? null,
            input.title ?? null,
            input.content,
            metadata,
            formatVector(embedding),
          ],
          type: QueryTypes.SELECT,
          transaction: t,
        },
      );
      return toMemory(rows[0]);
    });
  }

  /**
   * The `k` nearest memories to `embedding` by cosine distance (the `<=>` operator, matching the
   * `vector_cosine_ops` HNSW index), optionally filtered to a single `kind`. Rows are RLS-scoped to
   * the current tenant. Returns each mapped memory plus its `distance` (smaller = more similar).
   */
  searchSimilar(embedding: number[], k: number, opts?: { kind?: string }): Promise<RecallHit[]> {
    const literal = formatVector(embedding);
    return this.run(async (t) => {
      const bind: unknown[] = [literal];
      let where = '';
      if (opts?.kind !== undefined) {
        bind.push(opts.kind);
        where = `WHERE kind = $${bind.length}`;
      }
      bind.push(k);
      const limitParam = `$${bind.length}`;
      const rows = await getSequelize().query<AppBrainRow & { distance: number }>(
        `SELECT id, tenant_id, kind, ref, title, content, metadata, created_at, updated_at,
                embedding <=> $1::vector AS distance
           FROM "${APP_BRAIN}"
           ${where}
          ORDER BY embedding <=> $1::vector
          LIMIT ${limitParam}`,
        { bind, type: QueryTypes.SELECT, transaction: t },
      );
      return rows.map((row) => ({ ...toMemory(row), distance: Number(row.distance) }));
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
