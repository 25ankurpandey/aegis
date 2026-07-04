/**
 * Types for the per-tenant "app-brain" semantic-memory store (the `app_brain_memory` table): the
 * self-knowledge / RAG substrate. Each row is one embedded memory (a doc chunk, a tool description,
 * an audit finding, a note, ...) scoped to a single tenant via FORCE + RESTRICTIVE RLS exactly like
 * every other tenant table. The embedding column is a pgvector `vector` and is never mapped back
 * into these scalar domain types.
 */

/**
 * The vector column dimension — the SINGLE SOURCE OF TRUTH shared by the migration (the
 * `vector(N)` column) and the default {@link import('./embedding-client').HashingEmbeddingClient}.
 * If you swap in a provider whose embeddings have a different dimension (e.g. OpenAI
 * `text-embedding-3-small` = 1536), this constant AND the column must change together in a new
 * migration.
 */
export const APP_BRAIN_EMBEDDING_DIM = 384;

/**
 * The kind of memory. A small set of well-known kinds plus an open `string` so callers can add
 * their own without a type change; the DB stores it as free TEXT.
 */
export type AppBrainKind = 'doc' | 'tool' | 'audit_finding' | 'note' | string;

/** Input to remember (store) a memory. `ref` (when set) makes the memory upsertable per kind. */
export interface RememberInput {
  kind: AppBrainKind;
  /** Stable external key within (tenant, kind); when non-null the write upserts on it. */
  ref?: string | null;
  title?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
}

/** An `app_brain_memory` row as read back from the DB (tenant-scoped via RLS; no embedding column). */
export interface AppBrainMemory {
  id: string;
  tenantId: string;
  kind: AppBrainKind;
  ref: string | null;
  title: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A recall result: a memory plus its cosine distance from the query embedding (smaller = closer). */
export interface RecallHit extends AppBrainMemory {
  distance: number;
}
