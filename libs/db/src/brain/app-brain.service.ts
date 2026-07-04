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
 * Every read/write is RLS-scoped through the repository, so a service instance only ever sees its
 * own tenant's memories. Construct with `{ tenantId }` to answer off the request path
 * (workers/tests); on the request path the ambient RequestContext tenant is used. Inject a different
 * embedding provider via `deps.embedding` — but its `dimensions` MUST match the table's `vector(N)`
 * column (see APP_BRAIN_EMBEDDING_DIM).
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

  /** Embed `input.content` and store it as a tenant memory. Returns the persisted memory. */
  async remember(input: RememberInput): Promise<AppBrainMemory> {
    const embedding = await this.embedding.embed(input.content);
    return this.repo.remember(input, embedding);
  }

  /** Embed `query` and return the `k` most similar tenant memories (optionally filtered by kind). */
  async recall(query: string, k = 5, opts?: { kind?: string }): Promise<RecallHit[]> {
    const embedding = await this.embedding.embed(query);
    return this.repo.searchSimilar(embedding, k, opts);
  }
}
