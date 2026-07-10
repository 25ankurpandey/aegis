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

/**
 * Owner-scoping for a memory (migration 0036, closes AGENT-03/MEM-01/02/03):
 * - `private` (DEFAULT) — visible only to its owner (`owner_user_id`) plus legacy owner-less rows.
 * - `team`              — tenant-shared: every user in the tenant can recall it.
 * Owner scoping is an APP-LAYER predicate layered on top of the tenant RLS (never replaces it).
 */
export type MemoryScope = 'private' | 'team';

/** Input to remember (store) a memory. `ref` (when set) makes the memory upsertable per kind. */
export interface RememberInput {
  kind: AppBrainKind;
  /** Stable external key within (tenant, kind); when non-null the write upserts on it. */
  ref?: string | null;
  /**
   * Visibility scope (default `private`). `private` memories are readable only by their owner (the
   * acting user threaded through the repository/service) plus legacy owner-less rows; `team`
   * memories are tenant-shared. The owner itself is NOT taken from this input — it comes from the
   * repository's `userId` option so a caller can never spoof another user's ownership.
   */
  scope?: MemoryScope;
  /**
   * SUPERSESSION key (Wayfinder memory semantics): when non-blank, `remember` first
   * soft-invalidates (sets `valid_to = now()`) every LIVE row of the same tenant whose trimmed
   * lower(subject) matches, then inserts — so "my car is on level 5" REPLACES "…level 3" instead of
   * accumulating stale duplicates. Blank/absent supersedes nothing (subject-less facts never
   * collide). Stored trimmed (original case); matched case-insensitively.
   */
  subject?: string | null;
  title?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
  /** Optional salience weight (caller-defined scale; stored, not yet used for ranking). */
  importance?: number | null;
}

/** An `app_brain_memory` row as read back from the DB (tenant-scoped via RLS; no embedding column). */
export interface AppBrainMemory {
  id: string;
  tenantId: string;
  kind: AppBrainKind;
  ref: string | null;
  /** Supersession key (see {@link RememberInput.subject}); null for subject-less memories. */
  subject: string | null;
  title: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  /**
   * Vector-SPACE tag of the stored embedding (e.g. `fnv1a-bow-384/v1`). Recall only ever compares
   * rows in the SAME space as the querying {@link import('./embedding-client').EmbeddingClient} —
   * vector spaces must never be mixed.
   */
  embedder: string;
  /** Optional salience weight as stored (see {@link RememberInput.importance}). */
  importance: number | null;
  /**
   * Owning user (migration 0036). NULL = a legacy/tenant-shared row written before owner-scoping —
   * such rows stay visible to every user in the tenant for back-compat. Otherwise the user who owns
   * a `private` memory.
   */
  ownerUserId: string | null;
  /** Visibility scope (see {@link MemoryScope}): `private` (owner-only) or `team` (tenant-shared). */
  scope: MemoryScope;
  /** Provenance (MEM-03): the user who first stored this memory. NULL on legacy/off-request writes. */
  createdBy: string | null;
  /** Provenance (MEM-03): the user who last wrote/superseded this memory. NULL on legacy writes. */
  updatedBy: string | null;
  /**
   * Soft-invalidation tombstone (Zep/Graphiti-style `valid_to`, per ADR-0001): NULL = LIVE; set =
   * superseded or forgotten. Dead rows are kept for audit/history but excluded from every read path
   * (recall/profile/salient).
   */
  validTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A recall result: a memory plus its cosine distance from the query embedding (smaller = closer). */
export interface RecallHit extends AppBrainMemory {
  distance: number;
}
