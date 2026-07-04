import Redis from 'ioredis';
import type { PendingAction, PendingActionStore } from '../execution/supervised-action-broker';

/**
 * @aegis/ai-core / persistence — a durable, Redis-backed {@link PendingActionStore}.
 *
 * WHY THIS EXISTS: a supervised write is a two-step ceremony split across time — `propose` computes the
 * danger gate and PERSISTS the pending action; the human completes the ceremony; a LATER `confirm` loads
 * it and executes. The default {@link InMemoryPendingActionStore} keeps those pending actions in a Map, so
 * a node restart between propose and confirm silently drops every in-flight challenge. Backing the store
 * with Redis makes a propose→confirm survive restarts and be visible across nodes.
 *
 * WHY THE TTL IS SECURITY, NOT JUST HYGIENE: a pending action is a live, pre-gated capability — anyone who
 * later presents valid ceremony evidence for its id gets to execute it. It must NOT live forever. Every
 * entry is written with an EXPIRE so a stale, unclaimed challenge auto-expires (a cooling-off / anti-replay
 * bound): an old challenge cannot be dredged up and confirmed long after it was proposed. On expiry `get`
 * returns `undefined`, which the broker already treats as "unknown or expired" and refuses fail-closed.
 * The broker also deletes the entry on successful execution, so a confirmed action can never be replayed.
 *
 * SERIALIZATION NOTE: {@link PendingAction} is plain JSON data (tool descriptor, args, decision, invoke
 * context) with one exception — `invoke.fetchImpl`, an optional injected function, does not survive a JSON
 * round-trip and is intentionally not persisted; the broker/tool-server defaults it to the global `fetch`.
 */

/** Default TTL for a pending action: 1 hour. A challenge unclaimed for this long expires and is refused. */
export const DEFAULT_PENDING_TTL_SECONDS = 3600;

/** Options for {@link RedisPendingActionStore}. Supply either a live client (`redis`) or a `url`. */
export interface RedisPendingActionStoreOptions {
  /** A pre-constructed ioredis client (shared connection). Mutually exclusive with `url`. */
  redis?: Redis;
  /** A redis:// URL to construct a client from, when you are not sharing an existing connection. */
  url?: string;
  /** Namespace for this store's keys (default `aegis`). Final key is `${keyPrefix}:pending:${id}`. */
  keyPrefix?: string;
  /** TTL (seconds) applied to every pending action (default {@link DEFAULT_PENDING_TTL_SECONDS}). */
  ttlSeconds?: number;
}

export class RedisPendingActionStore implements PendingActionStore {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(options: RedisPendingActionStoreOptions) {
    if (!options.redis && !options.url) {
      throw new Error('RedisPendingActionStore requires either a `redis` client or a `url`.');
    }
    this.redis = options.redis ?? new Redis(options.url as string);
    this.keyPrefix = options.keyPrefix ?? 'aegis';
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_PENDING_TTL_SECONDS;
  }

  /** The Redis key for a pending action id. */
  private actionKey(id: string): string {
    return `${this.keyPrefix}:pending:${id}`;
  }

  /** Persist a pending action as JSON with an EXPIRE so a stale, unclaimed challenge cannot outlive its TTL. */
  async put(action: PendingAction): Promise<void> {
    await this.redis.set(this.actionKey(action.id), JSON.stringify(action), 'EX', this.ttlSeconds);
  }

  /** Load a pending action by id — `undefined` if absent or already expired (broker refuses fail-closed). */
  async get(id: string): Promise<PendingAction | undefined> {
    const raw = await this.redis.get(this.actionKey(id));
    if (raw === null) return undefined;
    return JSON.parse(raw) as PendingAction;
  }

  /** Delete a pending action (called by the broker after a successful confirm, so it cannot be replayed). */
  async delete(id: string): Promise<void> {
    await this.redis.del(this.actionKey(id));
  }
}
