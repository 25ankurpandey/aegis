import type { Server } from 'node:http';
import { Logger } from '../logging/logger';

/** A named cleanup hook run during graceful shutdown (close DB pool, stop bus, quit Redis, …). */
export interface ShutdownHook {
  /** Label for logging/ordering diagnostics. */
  name: string;
  /** The async cleanup. Should be best-effort and not throw; throws are caught + logged. */
  run: () => Promise<void> | void;
}

/** Ordered registry of cleanup hooks. Hooks run in REVERSE registration order (LIFO), like a stack. */
const hooks: ShutdownHook[] = [];
let installed = false;
let shuttingDown = false;

/**
 * Register a cleanup hook to run on graceful shutdown. Apps call this to close their DB pool
 * (`closeSequelize`), stop the event bus (`bus.stop()` on a KafkaBus), and quit Redis. Hooks run in
 * LIFO order so resources tear down in the reverse order they were brought up. Returns an unregister
 * fn (useful in tests).
 */
export function onShutdown(hook: ShutdownHook): () => void {
  hooks.push(hook);
  return () => {
    const i = hooks.indexOf(hook);
    if (i >= 0) hooks.splice(i, 1);
  };
}

/** Test/diagnostic helper: the currently-registered hook names, in registration order. */
export function shutdownHookNames(): string[] {
  return hooks.map((h) => h.name);
}

/** Clear the registry + reset signal-handler state (tests only). */
export function resetShutdown(): void {
  hooks.length = 0;
  installed = false;
  shuttingDown = false;
}

export interface RunShutdownOptions {
  /** The HTTP server to stop accepting connections on and drain (server.close). */
  server?: Server;
  /** Hard deadline (ms) after which we force-exit even if drain/hooks hang. Default 10000. */
  timeoutMs?: number;
  /** Reason/signal that triggered shutdown (for logging). */
  reason?: string;
}

/**
 * Run the graceful-shutdown sequence ONCE (idempotent across repeated signals):
 *   1. stop accepting new connections + drain in-flight requests (`server.close`),
 *   2. run every registered cleanup hook in LIFO order (each best-effort, errors logged),
 * all under a hard timeout so a hung dependency can't wedge the pod forever. Returns when complete;
 * the caller (signal handler) exits the process.
 */
export async function runShutdown(opts: RunShutdownOptions = {}): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  Logger.info('graceful shutdown started', { reason: opts.reason, hooks: shutdownHookNames() });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      Logger.alert('graceful shutdown timed out; forcing exit', { timeoutMs });
      resolve();
    }, timeoutMs);
    // Don't let the timer itself keep the loop alive.
    timer.unref?.();
  });

  const sequence = (async () => {
    // 1. Stop the listener + drain in-flight requests.
    if (opts.server) {
      await new Promise<void>((resolve) => {
        opts.server?.close((err) => {
          if (err) Logger.error(err, 'SHUTDOWN', 'server.close');
          else Logger.info('http listener closed (drained in-flight requests)');
          resolve();
        });
      });
    }
    // 2. Run cleanup hooks LIFO (reverse of registration).
    for (let i = hooks.length - 1; i >= 0; i -= 1) {
      const hook = hooks[i];
      try {
        await hook.run();
        Logger.info('shutdown hook complete', { hook: hook.name });
      } catch (err) {
        Logger.error(err as Error, 'SHUTDOWN_HOOK', hook.name);
      }
    }
  })();

  await Promise.race([sequence, deadline]);
  if (timer) clearTimeout(timer);
  Logger.info('graceful shutdown complete', { reason: opts.reason });
}

/**
 * Install SIGTERM/SIGINT handlers that run {@link runShutdown} then exit. Idempotent — calling twice
 * does not double-register. The handlers exit with code 0 on clean drain, 1 if a hook threw fatally.
 */
export function installSignalHandlers(opts: RunShutdownOptions = {}): void {
  if (installed) return;
  installed = true;
  const handle = (signal: NodeJS.Signals): void => {
    void runShutdown({ ...opts, reason: signal })
      .then(() => process.exit(0))
      .catch((err) => {
        Logger.error(err as Error, 'SHUTDOWN', 'fatal');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
}
