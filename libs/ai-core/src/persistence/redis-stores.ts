import Redis from 'ioredis';
import {
  RedisConversationStore,
  type RedisConversationStoreOptions,
} from './redis-conversation-store';
import {
  RedisPendingActionStore,
  type RedisPendingActionStoreOptions,
} from './redis-pending-action-store';

/**
 * @aegis/ai-core / persistence — factory for the durable, Redis-backed orchestrator stores.
 *
 * Builds a {@link RedisConversationStore} and a {@link RedisPendingActionStore} over ONE shared ioredis
 * connection, so a deployment wires "durable session memory + durable pending supervised actions" in a
 * single call. Both returned stores hold the same client; own the returned {@link redis} and close it
 * (`redis.quit()`) on shutdown.
 */

/** Per-store option overrides (the shared connection is supplied by the factory, not by these). */
export interface MakeRedisStoresOptions {
  /** Shared across both stores unless overridden per store. */
  keyPrefix?: string;
  conversation?: Omit<RedisConversationStoreOptions, 'redis' | 'url'>;
  pendingAction?: Omit<RedisPendingActionStoreOptions, 'redis' | 'url'>;
}

/** The durable stores plus the shared connection backing them (close it on shutdown). */
export interface RedisStores {
  conversationStore: RedisConversationStore;
  pendingActionStore: RedisPendingActionStore;
  redis: Redis;
}

/** Construct both durable stores over a single shared ioredis connection to `redisUrl`. */
export function makeRedisStores(redisUrl: string, opts: MakeRedisStoresOptions = {}): RedisStores {
  const redis = new Redis(redisUrl);
  const conversationStore = new RedisConversationStore({
    redis,
    keyPrefix: opts.conversation?.keyPrefix ?? opts.keyPrefix,
    maxTurns: opts.conversation?.maxTurns,
    ttlSeconds: opts.conversation?.ttlSeconds,
  });
  const pendingActionStore = new RedisPendingActionStore({
    redis,
    keyPrefix: opts.pendingAction?.keyPrefix ?? opts.keyPrefix,
    ttlSeconds: opts.pendingAction?.ttlSeconds,
  });
  return { conversationStore, pendingActionStore, redis };
}
