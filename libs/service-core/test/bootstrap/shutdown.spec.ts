import { onShutdown, runShutdown, shutdownHookNames, resetShutdown } from '../../src/bootstrap/shutdown';

describe('graceful shutdown (W2-01)', () => {
  beforeEach(() => resetShutdown());
  afterEach(() => resetShutdown());

  it('registers hooks and reports their names', () => {
    onShutdown({ name: 'db', run: async () => undefined });
    onShutdown({ name: 'bus', run: async () => undefined });
    expect(shutdownHookNames()).toEqual(['db', 'bus']);
  });

  it('runs hooks in LIFO (reverse registration) order', async () => {
    const order: string[] = [];
    onShutdown({ name: 'db', run: () => void order.push('db') });
    onShutdown({ name: 'bus', run: () => void order.push('bus') });
    onShutdown({ name: 'redis', run: () => void order.push('redis') });
    await runShutdown({ reason: 'test' });
    expect(order).toEqual(['redis', 'bus', 'db']);
  });

  it('is idempotent — a second runShutdown does not re-run hooks', async () => {
    const run = jest.fn();
    onShutdown({ name: 'once', run });
    await runShutdown({ reason: 'a' });
    await runShutdown({ reason: 'b' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('continues running remaining hooks when one throws (best-effort)', async () => {
    const after = jest.fn();
    onShutdown({ name: 'good', run: after });
    onShutdown({
      name: 'bad',
      run: () => {
        throw new Error('cleanup failed');
      },
    });
    await expect(runShutdown({ reason: 'test' })).resolves.toBeUndefined();
    // 'good' was registered before 'bad', so LIFO runs 'bad' (throws) then 'good'.
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('drains the http server (server.close) before hooks run', async () => {
    const events: string[] = [];
    const fakeServer = {
      close: (cb: (err?: Error) => void) => {
        events.push('server.close');
        cb();
      },
    } as unknown as import('node:http').Server;
    onShutdown({ name: 'db', run: () => void events.push('hook') });
    await runShutdown({ server: fakeServer, reason: 'test' });
    expect(events).toEqual(['server.close', 'hook']);
  });

  it('returns even if a hook hangs past the timeout (hard deadline)', async () => {
    onShutdown({ name: 'hang', run: () => new Promise<void>(() => undefined) });
    await expect(runShutdown({ reason: 'test', timeoutMs: 20 })).resolves.toBeUndefined();
  });
});
