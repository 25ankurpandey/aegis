import Redis from 'ioredis';
import type { ConversationTurn } from '../src/memory/conversation-store';
import { sessionKey } from '../src/memory/conversation-store';
import { RedisConversationStore } from '../src/persistence/redis-conversation-store';
import { RedisPendingActionStore } from '../src/persistence/redis-pending-action-store';
import { makeRedisStores } from '../src/persistence/redis-stores';
import type { PendingAction } from '../src/execution/supervised-action-broker';
import type { AegisTool } from '../src/tool-registry/types';
import type { InvokeContext } from '../src/tool-server/tool-server';
import { deriveDangerFacts } from '../src/orchestrator/derive-danger-facts';
import { evaluateActionGate } from '../src/danger/danger-gate';

/**
 * TRACK 3 — durable Redis-backed stores. INTEGRATION against the LIVE Redis at 127.0.0.1:6380 (no mocks).
 * We prove the two interfaces round-trip through real Redis: (a) conversation append/history round-trips,
 * tail-limits, respects maxTurns LTRIM, and is isolated across two different keys; (b) pending
 * put/get/delete round-trips and get() returns undefined after delete; (c) a short TTL actually expires an
 * entry. A unique keyPrefix per run keeps parallel/prior runs from colliding; afterAll flushes the prefix.
 */

const REDIS_URL = process.env.AEGIS_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';
// Unique namespace for this run so nothing collides and cleanup is scoped to just our keys.
const PREFIX = `aegis-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';

/** A real DangerDecision that is NOT `allow` (so it is a genuine pending action), built via the real gate. */
function buildPendingAction(id: string): PendingAction {
  const tool: AegisTool = {
    name: 'delete_invoices',
    method: 'DELETE',
    path: '/billing/api/v1/invoices',
    permissions: ['invoice:delete'],
    requiresAuth: true,
    inputSchema: { type: 'object', properties: { count: { type: 'number' } } },
    inputSources: ['body'],
    description: 'Delete invoices in bulk.',
    riskTier: 4,
    tags: ['invoice', 'delete'],
  };
  const args = { count: 4211 };
  const gateContext = { approverPoolSize: 3 };
  const decision = evaluateActionGate(deriveDangerFacts(tool, args), gateContext);
  const invoke: InvokeContext = {
    baseUrl: 'http://127.0.0.1:4002',
    token: 'test-bearer',
    tenantId: TENANT_A,
    correlationId: 'corr-1',
  };
  return {
    id,
    proposer: { userId: 'u1', tenantId: TENANT_A },
    tool,
    args,
    invoke,
    decision,
    gateContext,
    createdAt: Date.now(),
  };
}

let redis: Redis;
let reachable = true;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const pong = await redis.ping();
    reachable = pong === 'PONG';
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  if (redis) {
    try {
      const keys = await redis.keys(`${PREFIX}:*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      /* best-effort cleanup */
    }
    await redis.quit();
  }
});

describe('RedisConversationStore (live Redis)', () => {
  it('round-trips append/history and tail-limits', async () => {
    if (!reachable) return;
    const store = new RedisConversationStore({ redis, keyPrefix: PREFIX });
    const key = sessionKey(TENANT_A, 'sess-conv-1');

    const turns: ConversationTurn[] = [
      { role: 'user', content: 'hello', at: 1 },
      { role: 'assistant', content: 'hi there', at: 2 },
      { role: 'user', content: 'delete my invoices', at: 3 },
    ];
    for (const t of turns) await store.append(key, t);

    const all = await store.history(key);
    expect(all).toEqual(turns);

    const tail = await store.history(key, 2);
    expect(tail).toEqual(turns.slice(-2));
  });

  it('LTRIMs to maxTurns so the record stays bounded', async () => {
    if (!reachable) return;
    const store = new RedisConversationStore({ redis, keyPrefix: PREFIX, maxTurns: 3 });
    const key = sessionKey(TENANT_A, 'sess-conv-bounded');
    for (let i = 0; i < 10; i++) {
      await store.append(key, { role: 'user', content: `msg-${i}` });
    }
    const all = await store.history(key);
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.content)).toEqual(['msg-7', 'msg-8', 'msg-9']);
  });

  it('isolates two different keys and clear() empties only its key', async () => {
    if (!reachable) return;
    const store = new RedisConversationStore({ redis, keyPrefix: PREFIX });
    const keyA = sessionKey(TENANT_A, 'shared-session-id');
    const keyB = sessionKey(TENANT_B, 'shared-session-id');

    await store.append(keyA, { role: 'user', content: 'tenant A secret' });
    await store.append(keyB, { role: 'user', content: 'tenant B secret' });

    expect(await store.history(keyA)).toEqual([{ role: 'user', content: 'tenant A secret' }]);
    expect(await store.history(keyB)).toEqual([{ role: 'user', content: 'tenant B secret' }]);

    await store.clear(keyA);
    expect(await store.history(keyA)).toEqual([]);
    // B is untouched by A's clear.
    expect(await store.history(keyB)).toEqual([{ role: 'user', content: 'tenant B secret' }]);
  });

  it('expires a session when a short TTL is set', async () => {
    if (!reachable) return;
    const store = new RedisConversationStore({ redis, keyPrefix: PREFIX, ttlSeconds: 1 });
    const key = sessionKey(TENANT_A, 'sess-conv-ttl');
    await store.append(key, { role: 'user', content: 'ephemeral' });
    expect(await store.history(key)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await store.history(key)).toEqual([]);
  });
});

describe('RedisPendingActionStore (live Redis)', () => {
  it('round-trips put/get and returns undefined after delete', async () => {
    if (!reachable) return;
    const store = new RedisPendingActionStore({ redis, keyPrefix: PREFIX });
    const pending = buildPendingAction('pending-1');

    await store.put(pending);
    const loaded = await store.get('pending-1');
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe('pending-1');
    expect(loaded?.tool.name).toBe('delete_invoices');
    expect(loaded?.args).toEqual({ count: 4211 });
    expect(loaded?.decision.ceremony).toBe(pending.decision.ceremony);
    expect(loaded?.invoke.tenantId).toBe(TENANT_A);

    await store.delete('pending-1');
    expect(await store.get('pending-1')).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    if (!reachable) return;
    const store = new RedisPendingActionStore({ redis, keyPrefix: PREFIX });
    expect(await store.get('never-existed')).toBeUndefined();
  });

  it('expires a pending action after its TTL (stale-challenge defense)', async () => {
    if (!reachable) return;
    const store = new RedisPendingActionStore({ redis, keyPrefix: PREFIX, ttlSeconds: 1 });
    const pending = buildPendingAction('pending-ttl');
    await store.put(pending);
    expect(await store.get('pending-ttl')).toBeDefined();
    await new Promise((r) => setTimeout(r, 1500));
    expect(await store.get('pending-ttl')).toBeUndefined();
  });
});

describe('makeRedisStores factory (live Redis)', () => {
  it('builds both stores over one shared connection', async () => {
    if (!reachable) return;
    const stores = makeRedisStores(REDIS_URL, { keyPrefix: PREFIX });
    try {
      const key = sessionKey(TENANT_A, 'factory-session');
      await stores.conversationStore.append(key, { role: 'user', content: 'via factory' });
      expect(await stores.conversationStore.history(key)).toEqual([
        { role: 'user', content: 'via factory' },
      ]);

      const pending = buildPendingAction('factory-pending');
      await stores.pendingActionStore.put(pending);
      expect((await stores.pendingActionStore.get('factory-pending'))?.id).toBe('factory-pending');
      await stores.pendingActionStore.delete('factory-pending');
    } finally {
      await stores.redis.quit();
    }
  });
});
