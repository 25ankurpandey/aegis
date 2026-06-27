import Redis from 'ioredis';
import { Config, Logger } from '@aegis/service-core';

/**
 * Casbin policy-reload bus (W5-03).
 *
 * The enforcer is a build-once process singleton (`pep.ts`): it `loadPolicy()`s once at boot and
 * then serves every request from that in-memory snapshot. PAP mutations (createRole / setPermissions
 * / assignRole) write new grants to the policy store at RUNTIME, but those writes NEVER reach the
 * already-running pods — so "dynamic runtime roles/permissions" (SPEC §1/§2.2) silently does nothing
 * until a restart. That is a correctness *and* a security bug (a revoked grant keeps working).
 *
 * This module is the fan-out that closes the gap: after any PAP write, the writer pod publishes an
 * invalidation on a Redis pub/sub channel; EVERY pod (including the writer) is subscribed and reloads
 * its enforcer from the store on receipt. Redis pub/sub is at-most-once and fire-and-forget, which is
 * exactly right here — a missed message only delays convergence, and we additionally fail CLOSED: if
 * a reload throws, the reload callback clears the enforcer's policy so the pod denies until it can
 * successfully reload, rather than serving a stale (possibly over-permissive) snapshot.
 *
 * A subscribed ioredis connection cannot issue normal commands, so we hold TWO dedicated connections
 * (publisher + subscriber), separate from the shared `CacheAdapter` client. Both are lazily created
 * and torn down by `stopPolicyWatcher()` (wired to the bootstrap shutdown hooks).
 *
 * Wiring is OPTIONAL and fail-open at startup: if Redis is unreachable, `startPolicyWatcher()` logs
 * and returns — a single-pod / local run still works (its own in-process reload after a PAP write is
 * driven directly, see `pap.service.ts`), it just loses cross-pod fan-out.
 */

/** Redis channel every api pod LISTENs on for "reload your enforcer now". */
export const POLICY_RELOAD_CHANNEL = 'aegis:access-control:policy-reload';

/** Called on an inbound reload signal. Wired by `startPolicyWatcher` to `reloadEnforcer` (pep.ts). */
export type ReloadHandler = () => Promise<void>;

interface WatcherState {
  publisher: Redis;
  subscriber: Redis;
}

let state: WatcherState | undefined;
let connecting: Promise<void> | undefined;

function redisUrl(): string {
  return Config.get('REDIS_URL', 'redis://localhost:6379') as string;
}

/**
 * Start the policy-reload watcher: subscribe to the reload channel and invoke `onReload` on every
 * message. Idempotent — a second call is a no-op. Fail-open: a Redis connection error is logged and
 * swallowed so a pod without Redis still boots (it just won't receive cross-pod invalidations).
 */
export async function startPolicyWatcher(onReload: ReloadHandler): Promise<void> {
  if (state || connecting) {
    await connecting;
    return;
  }
  connecting = (async () => {
    const url = redisUrl();
    const publisher = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    const subscriber = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    try {
      await subscriber.connect();
      await publisher.connect();
      await subscriber.subscribe(POLICY_RELOAD_CHANNEL);
      subscriber.on('message', (channel: string) => {
        if (channel !== POLICY_RELOAD_CHANNEL) return;
        onReload().catch((err) => {
          // Reload failure is fail-closed inside reloadEnforcer; surface it for ops.
          Logger.error(err as Error, 'POLICY_RELOAD_FAILED', 'ACCESS_CONTROL');
        });
      });
      state = { publisher, subscriber };
      Logger.info('access-control policy watcher started', { channel: POLICY_RELOAD_CHANNEL });
    } catch (err) {
      // Fail-open at startup: tear down half-open connections and continue without cross-pod fan-out.
      publisher.disconnect();
      subscriber.disconnect();
      Logger.warn('access-control policy watcher unavailable (Redis down?) — running without cross-pod reload', {
        error: (err as Error).message,
      });
    }
  })();
  try {
    await connecting;
  } finally {
    connecting = undefined;
  }
}

/**
 * Publish a policy-reload signal to every subscribed pod. Call AFTER a successful PAP write (and after
 * projecting the grant into the store) so all pods converge on the new policy. Best-effort: a publish
 * failure is logged, not thrown — the writer pod has already reloaded itself in-process, so the local
 * request is correct; only remote fan-out is affected. Returns the number of subscribers reached when
 * known (Redis PUBLISH reply), else 0.
 */
export async function invalidatePolicies(): Promise<number> {
  if (!state) return 0;
  try {
    return await state.publisher.publish(POLICY_RELOAD_CHANNEL, Date.now().toString());
  } catch (err) {
    Logger.warn('access-control policy invalidation publish failed', { error: (err as Error).message });
    return 0;
  }
}

/** True when the watcher's connections are live (mainly for tests / health). */
export function isPolicyWatcherRunning(): boolean {
  return state !== undefined;
}

/** Tear down the watcher's Redis connections. Idempotent; wired into graceful shutdown. */
export async function stopPolicyWatcher(): Promise<void> {
  const current = state;
  state = undefined;
  if (!current) return;
  try {
    await current.subscriber.unsubscribe(POLICY_RELOAD_CHANNEL);
  } catch {
    /* best-effort */
  }
  await Promise.allSettled([current.publisher.quit(), current.subscriber.quit()]).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') {
        // quit() can reject if the socket is already gone; fall back to a hard disconnect.
        current.publisher.disconnect();
        current.subscriber.disconnect();
      }
    }
  });
}

/** Reset internal state for tests (does NOT close real connections — use stopPolicyWatcher for that). */
export function resetPolicyWatcherForTests(): void {
  state = undefined;
  connecting = undefined;
}

/** Inject ready pub/sub connections (tests / advanced wiring) without going through Redis discovery. */
export function setPolicyWatcherConnections(publisher: Redis, subscriber: Redis): void {
  state = { publisher, subscriber };
}
