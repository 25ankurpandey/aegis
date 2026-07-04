/**
 * CONVERSATION / SESSION MEMORY: the store that gives the orchestrator a memory across turns.
 *
 * ISOLATION-IN-THE-KEY: a store is a flat namespace keyed by string. Tenant/session isolation is NOT a
 * concern of the store implementation — it lives in the KEY the caller hands us (see {@link sessionKey}).
 * A store never inspects, parses, or trusts the key's structure; it only ever returns what was appended
 * under the exact same key. This keeps "the agent reasons; the governed core acts" honest: the store is a
 * dumb, side-effect-contained record, and cross-tenant leakage is impossible by construction as long as
 * callers derive keys through {@link sessionKey}.
 */

/** One recorded turn in a conversation. `at` is an optional wall-clock timestamp (ms since epoch). */
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  at?: number;
}

/**
 * A pluggable conversation record. Implementations may be sync or async (in-memory today; a Redis- or
 * Postgres-backed store tomorrow behind the same interface). All methods are keyed — the caller owns
 * isolation via the key (see {@link sessionKey}).
 */
export interface ConversationStore {
  /** Append one turn to the record under `key`. */
  append(key: string, turn: ConversationTurn): void | Promise<void>;
  /** Return a COPY of the record under `key`, optionally tail-limited to the last `limit` turns. */
  history(key: string, limit?: number): ConversationTurn[] | Promise<ConversationTurn[]>;
  /** Forget everything recorded under `key`. */
  clear(key: string): void | Promise<void>;
}

/**
 * Derive the storage key for a session. Isolation lives HERE, not in app logic: two different tenants (or
 * two different sessions within a tenant) produce different keys and therefore never share a record. Keep
 * all callers routing through this helper — never hand a raw sessionId to a {@link ConversationStore}.
 */
export function sessionKey(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}

/**
 * The default {@link ConversationStore}: a process-local Map of key → turns. Deterministic and offline —
 * suitable for tests and single-process deployments. `history` returns a defensive COPY so callers cannot
 * mutate the backing record.
 */
export class InMemoryConversationStore implements ConversationStore {
  private readonly records = new Map<string, ConversationTurn[]>();

  append(key: string, turn: ConversationTurn): void {
    const existing = this.records.get(key);
    if (existing) {
      existing.push(turn);
    } else {
      this.records.set(key, [turn]);
    }
  }

  history(key: string, limit?: number): ConversationTurn[] {
    const turns = this.records.get(key);
    if (!turns) return [];
    const slice = limit !== undefined && limit >= 0 ? turns.slice(-limit) : turns;
    // Defensive copy: callers must not be able to mutate the backing record.
    return slice.map((t) => ({ ...t }));
  }

  clear(key: string): void {
    this.records.delete(key);
  }
}

/**
 * TODO (compaction): once histories grow past the model's context budget, summarize the oldest turns into
 * a single `system` digest and drop them, keeping a bounded tail verbatim. Left as a documented hook so
 * the seam exists before the policy does; the orchestrator wrapper is the natural place to invoke it.
 */
export function compactIfNeeded(
  _store: ConversationStore,
  _key: string,
  _maxTurns?: number,
): void | Promise<void> {
  // Intentionally a no-op stub today. See the doc-comment above.
}
