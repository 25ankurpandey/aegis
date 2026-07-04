import { APP_BRAIN_EMBEDDING_DIM } from './types';

/**
 * Provider-agnostic embedding seam (mirrors the `LlmClient` seam elsewhere). A real provider —
 * OpenAI `text-embedding-3-small` (1536 dims), a hosted or local model, etc. — plugs in behind this
 * same interface. The vector column dimension MUST match the configured embedder's `dimensions`:
 * the {@link APP_BRAIN_EMBEDDING_DIM} default (384) matches {@link HashingEmbeddingClient}, so no
 * network and no new dependency is needed out of the box. Switching to a provider with a different
 * dimension is a new migration (the `vector(N)` column changes) — keep this seam clean so that swap
 * stays trivial: implement `embed` + report `dimensions`, and update the constant + column together.
 */
export interface EmbeddingClient {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

/** FNV-1a 32-bit hash. Deterministic, dependency-free; used to bucket tokens into vector slots. */
function fnv1a32(token: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps everything in 32-bit unsigned space).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * DETERMINISTIC, OFFLINE embedding client — the zero-dependency default. It produces a fixed-dim
 * bag-of-hashed-tokens vector: lowercase, tokenize on `/[^a-z0-9]+/`, hash each token with FNV-1a
 * into a bucket (`hash % dimensions`), accumulate term frequency, then L2-normalize. Same text →
 * identical vector. Not semantically rich (no learned embeddings), but it gives real lexical-overlap
 * similarity for tests and offline use, and slots behind {@link EmbeddingClient} so a real provider
 * is a drop-in replacement.
 */
export class HashingEmbeddingClient implements EmbeddingClient {
  readonly dimensions = APP_BRAIN_EMBEDDING_DIM;

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
    for (const token of tokens) {
      const bucket = fnv1a32(token) % this.dimensions;
      vec[bucket] += 1; // term frequency
    }
    // L2-normalize so cosine distance depends on direction (topic), not document length.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec; // zero vector guard (empty / all-symbol input) → all-zeros
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }
}
