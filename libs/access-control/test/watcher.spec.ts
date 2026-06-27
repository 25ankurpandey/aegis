/**
 * Watcher tests use a small in-memory `ioredis` fake (no real Redis): one shared pub/sub bus so a
 * publish on the publisher connection is delivered to the subscriber's `message` handler — enough to
 * prove the reload fan-out wiring (subscribe → onReload, publish → invalidate) without Docker.
 */
type MsgHandler = (channel: string, message: string) => void;

class FakeRedis {
  private static bus = new Map<string, Set<FakeRedis>>();
  private handlers: MsgHandler[] = [];
  connect = jest.fn(async () => undefined);
  quit = jest.fn(async () => undefined);
  disconnect = jest.fn(() => undefined);

  on(event: string, cb: MsgHandler): this {
    if (event === 'message') this.handlers.push(cb);
    return this;
  }
  async subscribe(channel: string): Promise<void> {
    if (!FakeRedis.bus.has(channel)) FakeRedis.bus.set(channel, new Set());
    FakeRedis.bus.get(channel)!.add(this);
  }
  async unsubscribe(channel: string): Promise<void> {
    FakeRedis.bus.get(channel)?.delete(this);
  }
  async publish(channel: string, message: string): Promise<number> {
    const subs = FakeRedis.bus.get(channel);
    if (!subs) return 0;
    for (const s of subs) for (const h of s.handlers) h(channel, message);
    return subs.size;
  }
  static reset(): void {
    FakeRedis.bus.clear();
  }
}

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => new FakeRedis()) }));

import {
  startPolicyWatcher,
  invalidatePolicies,
  stopPolicyWatcher,
  isPolicyWatcherRunning,
  resetPolicyWatcherForTests,
  POLICY_RELOAD_CHANNEL,
} from '../src/watcher';

describe('policy watcher (W5-03 reload fan-out)', () => {
  afterEach(async () => {
    await stopPolicyWatcher();
    resetPolicyWatcherForTests();
    FakeRedis.reset();
  });

  it('invokes onReload when an invalidation is published', async () => {
    const onReload = jest.fn(async () => undefined);
    await startPolicyWatcher(onReload);
    expect(isPolicyWatcherRunning()).toBe(true);

    const reached = await invalidatePolicies();
    expect(reached).toBeGreaterThanOrEqual(1);
    // message handlers are synchronous in the fake; let the promise microtask settle.
    await Promise.resolve();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('publishes on the agreed channel', async () => {
    const onReload = jest.fn(async () => undefined);
    await startPolicyWatcher(onReload);
    // The reload handler only fires for the agreed channel name.
    expect(POLICY_RELOAD_CHANNEL).toBe('aegis:access-control:policy-reload');
    await invalidatePolicies();
    await Promise.resolve();
    expect(onReload).toHaveBeenCalled();
  });

  it('start is idempotent (second call does not double-subscribe)', async () => {
    const onReload = jest.fn(async () => undefined);
    await startPolicyWatcher(onReload);
    await startPolicyWatcher(onReload);
    await invalidatePolicies();
    await Promise.resolve();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('invalidatePolicies is a no-op (0 reached) when the watcher never started', async () => {
    expect(await invalidatePolicies()).toBe(0);
  });

  it('stop tears down and makes the watcher inactive', async () => {
    await startPolicyWatcher(jest.fn(async () => undefined));
    expect(isPolicyWatcherRunning()).toBe(true);
    await stopPolicyWatcher();
    expect(isPolicyWatcherRunning()).toBe(false);
  });
});
