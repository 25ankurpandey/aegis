import type { Server } from 'node:http';
import express, { type Application } from 'express';
import helmet from 'helmet';
import type { interfaces } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import { contextMiddleware, type ContextMiddlewareOptions } from '../middleware/context.middleware';
import { requestLogMiddleware } from '../middleware/request-log.middleware';
import { errorMiddleware } from '../middleware/error.middleware';
import { auditMiddleware, type HttpAuditOptions } from '../middleware/audit.middleware';
import { corsMiddleware, type CorsOptions } from '../middleware/cors.middleware';
import {
  idempotencyMiddleware,
  type IdempotencyOptions,
} from '../middleware/idempotency.middleware';
import { Config } from '../config/config';
import { Logger } from '../logging/logger';
import { installSignalHandlers } from './shutdown';
import { assertPepBeforeRoutes, type PepAssertionOptions } from './pep-assertion';

export interface CoreMiddlewareOptions {
  context?: ContextMiddlewareOptions;
  jsonLimit?: string;
  /** Enable explicit CORS (browser-facing services / gateway). `true` uses defaults; pass options to tune. */
  cors?: boolean | CorsOptions;
  /** Enable the cross-cutting HTTP request/response audit middleware. Default: ON. */
  audit?: boolean | HttpAuditOptions;
  /** Enable the idempotency-replay middleware for mutating requests carrying an Idempotency-Key. */
  idempotency?: boolean | IdempotencyOptions;
}

/**
 * Applies the standard infrastructure middleware band in the correct order:
 *   security headers → CORS (opt-in) → context (opens ALS) → json body → request-log → audit →
 *   idempotency (opt-in).
 * Services call this from `InversifyExpressServer.setConfig`, then add their PEP guards + routes,
 * then `attachErrorHandler` via `setErrorConfig` (error handler stays LAST).
 */
export function applyCoreMiddleware(app: Application, opts: CoreMiddlewareOptions = {}): void {
  app.disable('x-powered-by');
  app.use(helmet());
  if (opts.cors) {
    app.use(corsMiddleware(opts.cors === true ? undefined : opts.cors));
  }
  app.use(contextMiddleware(opts.context)); // opens the AsyncLocalStorage scope first
  app.use(express.json({ limit: opts.jsonLimit ?? '5mb' }));
  app.use(requestLogMiddleware);
  if (opts.audit !== false) {
    app.use(auditMiddleware(opts.audit === true || opts.audit === undefined ? undefined : opts.audit));
  }
  if (opts.idempotency) {
    app.use(idempotencyMiddleware(opts.idempotency === true ? undefined : opts.idempotency));
  }
}

/** Registers the single terminal error handler — must be last. */
export function attachErrorHandler(app: Application): void {
  app.use(errorMiddleware);
}

/**
 * Begin listening and (by default) install SIGTERM/SIGINT graceful-shutdown handlers bound to the
 * returned server so in-flight requests drain (server.close) before the registered `onShutdown` hooks
 * run. Returns the `http.Server` for callers that need it. Pass `installSignals:false` to opt out
 * (e.g. tests that manage their own server lifecycle).
 */
export function startServer(
  app: Application,
  opts: {
    port: number;
    serviceName: string;
    installSignals?: boolean;
    shutdownTimeoutMs?: number;
  },
): Server {
  const server = app.listen(opts.port, () =>
    Logger.info(`${opts.serviceName} listening on :${opts.port}`),
  );
  if (opts.installSignals !== false) {
    installSignalHandlers({ server, timeoutMs: opts.shutdownTimeoutMs });
  }
  return server;
}

/** Options for the shared composition-root helper. */
export interface CreateServiceOptions {
  /** The DI container loaded with the service's controllers + their dependencies. */
  container: interfaces.Container;
  /** Logical service name, used in the startup log line. */
  serviceName: string;
  /** Core middleware band options (context/header validation, json body limit). */
  middleware?: CoreMiddlewareOptions;
  /**
   * Extra app-level configuration applied AFTER the core middleware band but BEFORE the error
   * handler — e.g. mounting docs, health routes, or additional middleware the service owns.
   */
  configure?: (app: Application) => void;
  /**
   * Boot-time required-config gate. Every listed env var MUST be present + non-empty or
   * `createService` throws a single aggregated error listing all missing keys BEFORE the port is
   * bound — a service refuses to start rather than failing lazily on the first request.
   */
  requiredEnv?: readonly string[];
  /**
   * Boot-time fail-closed PEP assertion. When not `false`, after the app is built every registered
   * non-public route is checked for an `authenticate()`/`authorize()` guard and `createService`
   * THROWS if any unguarded non-public route is found — so a forgotten guard can never ship. Pass an
   * options object to tune the public-path allowlist; pass `false` to disable (not recommended).
   */
  assertPep?: boolean | PepAssertionOptions;
}

/** What a built service exposes: the Express app + a `start()` that begins listening. */
export interface AegisService {
  /** The fully built Express application (controllers + middleware + error handler wired). */
  app: Application;
  /** Begin listening on `port`, log the startup line, install graceful-shutdown handlers; returns the server. */
  start(port: number): Server;
}

/**
 * Composition-root helper (the thin-index → bootstrap pattern): builds an
 * InversifyExpressServer, applies the core middleware band (with `/health` excluded from context +
 * header validation by default), runs any service-supplied `configure`, attaches the single
 * terminal error handler, and returns `{ app, start }`.
 *
 * Each service can then keep a thin `index.ts` (reflect-metadata + `Logger.init` + import bootstrap)
 * and a `bootstrap.ts` that calls `createService(...)` and wires DB/cache/bus around it. The lower-
 * level helpers (`applyCoreMiddleware`, `attachErrorHandler`, `startServer`) remain exported for
 * services that need finer-grained control.
 */
export function createService(opts: CreateServiceOptions): AegisService {
  // Boot-time required-config gate — refuse to build (let alone listen) with missing critical env.
  if (opts.requiredEnv && opts.requiredEnv.length > 0) {
    Config.requireAll(opts.requiredEnv);
  }

  const middleware: CoreMiddlewareOptions = {
    ...opts.middleware,
    context: {
      excludePaths: ['/health'],
      ...opts.middleware?.context,
    },
  };

  const server = new InversifyExpressServer(opts.container);
  server.setConfig((app) => {
    applyCoreMiddleware(app, middleware);
    opts.configure?.(app);
  });
  server.setErrorConfig((app) => attachErrorHandler(app));

  const app = server.build();

  // Fail-closed PEP assertion: throw at boot if any non-public route lacks an auth guard.
  if (opts.assertPep !== false) {
    assertPepBeforeRoutes(app, opts.assertPep === true || opts.assertPep === undefined ? {} : opts.assertPep);
  }

  return {
    app,
    start(port: number): Server {
      return startServer(app, { port, serviceName: opts.serviceName });
    },
  };
}
