import Redis from 'ioredis';
import type { ConversationStore, ConversationTurn } from '../memory/conversation-store';

/**
 * @aegis/ai-core / persistence — a durable, Redis-backed {@link ConversationStore}.
 *
 * The default {@link InMemoryConversationStore} is a process-local Map: restart the node and every
 * session's memory is gone. This implementation persists each session's turns in a Redis LIST so the
 * orchestrator's cross-turn memory survives restarts and is shared across nodes.
 *
 * ISOLATION-IN-THE-KEY (unchanged): the store never inspects or trusts the key's structure. Tenant/session
 * isolation lives in the KEY the caller derives via `sessionKey(tenantId, sessionId)` — two different keys
 * map to two different Redis lists and therefore can never share a record. We only prefix the key so this
 * store's data is namespaced away from other Redis users; the caller-supplied key is appended verbatim.
 */

/** Options for {@link RedisConversationStore}. Supply either a live client (`redis`) or a `url`. */
export interface RedisConversationStoreOptions {
  /** A pre-constructed ioredis client (shared connection). Mutually exclusive with `url`. */
  redis?: Redis;
  /** A redis:// URL to construct a client from, when you are not sharing an existing connection. */
  url?: string;
  /** Namespace for this store's keys (default `aegis`). Final list key is `${keyPrefix}:conv:${key}`. */
  keyPrefix?: string;
  /** Cap on retained turns per session — LTRIM keeps only the newest `maxTurns` (default 200). */
  maxTurns?: number;
  /** Optional TTL (seconds) refreshed on every append; without it a session's memory lives forever. */
  ttlSeconds?: number;
}

export class RedisConversationStore implements ConversationStore {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly maxTurns: number;
  private readonly ttlSeconds?: number;

  constructor(options: RedisConversationStoreOptions) {
    if (!options.redis && !options.url) {
      throw new Error('RedisConversationStore requires either a `redis` client or a `url`.');
    }
    this.redis = options.redis ?? new Redis(options.url as string);
    this.keyPrefix = options.keyPrefix ?? 'aegis';
    this.maxTurns = options.maxTurns ?? 200;
    this.ttlSeconds = options.ttlSeconds;
  }

  /** The Redis list key for a caller-supplied session key. */
  private listKey(key: string): string {
    return `${this.keyPrefix}:conv:${key}`;
  }

  /** Append one turn: RPUSH the JSON, LTRIM to the newest `maxTurns`, and (optionally) refresh the TTL. */
  async append(key: string, turn: ConversationTurn): Promise<void> {
    const listKey = this.listKey(key);
    const pipeline = this.redis.multi();
    pipeline.rpush(listKey, JSON.stringify(turn));
    // Keep only the newest maxTurns: -maxTurns..-1 is the tail window.
    pipeline.ltrim(listKey, -this.maxTurns, -1);
    if (this.ttlSeconds !== undefined) {
      pipeline.expire(listKey, this.ttlSeconds);
    }
    await pipeline.exec();
  }

  /** Return the record under `key` as parsed turns, optionally tail-limited to the last `limit`. */
  async history(key: string, limit?: number): Promise<ConversationTurn[]> {
    const start = limit !== undefined && limit >= 0 ? -limit : 0;
    const raw = await this.redis.lrange(this.listKey(key), start, -1);
    return raw.map((entry) => JSON.parse(entry) as ConversationTurn);
  }

  /** Forget everything recorded under `key`. */
  async clear(key: string): Promise<void> {
    await this.redis.del(this.listKey(key));
  }
}
