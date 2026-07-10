import { AppBrainRepository } from './app-brain.repository';
import { HashingEmbeddingClient, type EmbeddingClient } from './embedding-client';
import type { AppBrainMemory, RecallHit, RememberInput } from './types';

/**
 * The per-tenant "app-brain" semantic-memory core (the `app_brain_memory` table): the
 * self-knowledge / RAG substrate. Thin domain wrapper over {@link AppBrainRepository} that owns the
 * embed step: it turns text into a vector via the {@link EmbeddingClient} seam (offline
 * {@link HashingEmbeddingClient} by default) and delegates persistence + similarity search to the
 * repository.
 *
 * v2 ports the Wayfinder memory semantics (server-side, Postgres-authoritative — no sync engine):
 * - SUPERSEDE-BY-SUBJECT: a non-blank {@link RememberInput.subject} soft-invalidates every live
 *   same-subject row before the insert, so fresh facts replace stale ones.
 * - SOFT-INVALIDATION: {@link forget}/{@link forgetBySubject} set `valid_to` instead of deleting;
 *   dead rows are kept for audit/history but leave every read path.
 * - EMBEDDER-SPACE TAGGING: rows store the {@link EmbeddingClient.embedderId} that produced their
 *   vector; {@link recall} only compares rows in the querying client's space (never mixes spaces).
 * - MINSCORE: {@link recall} can drop weak hits below a cosine-similarity floor.
 * - PROFILE/SALIENT: prompt-grounding reads — always-on profile facts and "what changed recently".
 *
 * Every read/write is RLS-scoped through the repository, so a service instance only ever sees its
 * own tenant's memories. Construct with `{ tenantId }` to answer off the request path
 * (workers/tests); on the request path the ambient RequestContext tenant is used. Inject a different
 * embedding provider via `deps.embedding` — but its `dimensions` MUST match the table's `vector(N)`
 * column (see APP_BRAIN_EMBEDDING_DIM), and its `embedderId` partitions recall to rows it embedded.
 *
 * OWNER-SCOPING (migration 0036, closes AGENT-03/MEM-01/02/03): construct with `{ userId }` (the
 * acting user) and the repository stamps ownership + provenance on writes and filters every read to
 * the user's own + `team`-scoped + legacy rows, so one user never recalls, supersedes, or forgets
 * another user's PRIVATE memory. A `RememberInput.scope` of `team` opts a fact into tenant-sharing;
 * absent/`private` keeps it owner-scoped. Method signatures are unchanged (`userId` was already a
 * constructor opt); off-request callers with no `userId` see only `team` + legacy rows.
 */
export class AppBrainService {
  private readonly repo: AppBrainRepository;
  private readonly embedding: EmbeddingClient;

  constructor(
    opts: { tenantId?: string; userId?: string } = {},
    deps: { embedding?: EmbeddingClient } = {},
  ) {
    this.repo = new AppBrainRepository(opts);
    this.embedding = deps.embedding ?? new HashingEmbeddingClient();
  }

  /**
   * Embed `input.content` and store it as a tenant memory (tagged with this client's embedder id),
   * owned by the constructor's `userId` and scoped by `input.scope` (default `private`; `team`
   * makes it tenant-shared). When `input.subject` is non-blank, every live same-subject row THIS
   * USER may tombstone (own + legacy) is superseded (soft-invalidated) first, in the same
   * transaction as the insert. Returns the persisted memory.
   */
  async remember(input: RememberInput): Promise<AppBrainMemory> {
    const embedding = await this.embedding.embed(input.content);
    return this.repo.remember(input, embedding, this.embedding.embedderId);
  }

  /**
   * Embed `query` and return the `k` most similar LIVE tenant memories in this client's vector
   * space (optionally filtered by kind). `opts.minScore` is a cosine-similarity floor in [0, 1]
   * (applied as `distance <= 1 - minScore`) that drops weak hits.
   */
  async recall(
    query: string,
    k = 5,
    opts?: { kind?: string; minScore?: number },
  ): Promise<RecallHit[]> {
    const embedding = await this.embedding.embed(query);
    return this.repo.searchSimilar(embedding, k, {
      ...opts,
      embedderId: this.embedding.embedderId,
    });
  }

  /**
   * Soft-invalidate one memory by id (`valid_to = now()`). Returns true when a live row was
   * invalidated; false when it does not exist, is another tenant's (RLS), or was already dead.
   */
  forget(id: string): Promise<boolean> {
    return this.repo.invalidateById(id);
  }

  /**
   * Soft-invalidate ALL live memories with the given subject (trimmed, case-insensitive). A blank
   * subject forgets nothing (returns 0). Returns the number of memories invalidated.
   */
  forgetBySubject(subject: string): Promise<number> {
    return this.repo.invalidateBySubject(subject);
  }

  /** Live `kind = "profile"` memories, newest updated first — the always-on prompt-grounding block. */
  profile(limit = 40): Promise<AppBrainMemory[]> {
    return this.repo.listByKind('profile', limit);
  }

  /** The most recently updated live memories of ANY kind, newest first — "what's salient now". */
  salient(limit = 10): Promise<AppBrainMemory[]> {
    return this.repo.listRecent(limit);
  }
}
