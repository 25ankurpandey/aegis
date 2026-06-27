import type { Application, RequestHandler } from 'express';

/**
 * Property stamped on a request handler to mark it as an authentication/authorization guard. The
 * access-control PEP tags `authenticate()` / `authorize()` with this via {@link markAuthGuard}, and
 * {@link assertPepBeforeRoutes} treats any route whose handler stack contains a tagged guard as
 * protected. Kept here (in service-core) so the assertion has no dependency on access-control and
 * there is no library cycle.
 */
export const AUTH_GUARD_MARKER = '__aegisAuthGuard' as const;

type GuardTaggable = RequestHandler & { [AUTH_GUARD_MARKER]?: boolean };

/** Tag a handler as an auth guard so the boot-time PEP assertion recognises it. Returns the handler. */
export function markAuthGuard<T extends RequestHandler>(handler: T): T {
  (handler as GuardTaggable)[AUTH_GUARD_MARKER] = true;
  return handler;
}

function isGuard(handle: unknown): boolean {
  return typeof handle === 'function' && (handle as GuardTaggable)[AUTH_GUARD_MARKER] === true;
}

export interface PepAssertionOptions {
  /**
   * Route path prefixes that are allowed to be public (no guard). Defaults to the infra surface:
   * `/health`, `/api-docs`, `/.well-known`, `/favicon.ico`. Matched as a prefix on the route path.
   */
  publicPaths?: string[];
  /**
   * When false (default), an unguarded non-public route THROWS at boot (fail-closed). When true, the
   * offending routes are returned instead of thrown — used by tests/diagnostics.
   */
  collectOnly?: boolean;
}

const DEFAULT_PUBLIC_PATHS = ['/health', '/api-docs', '/.well-known', '/favicon.ico'];

interface RouteLayer {
  route?: {
    path: string | string[];
    methods?: Record<string, boolean>;
    stack: Array<{ handle?: unknown; name?: string }>;
  };
  handle?: unknown;
  name?: string;
}

function routePaths(path: string | string[]): string[] {
  return Array.isArray(path) ? path : [path];
}

/**
 * Walk the built Express app's router stack and return every registered route that carries NO auth
 * guard and is not under a public prefix. Each entry is `"<METHODS> <path>"`.
 */
export function findUnguardedRoutes(app: Application, opts: PepAssertionOptions = {}): string[] {
  const publicPaths = opts.publicPaths ?? DEFAULT_PUBLIC_PATHS;
  // Express 4: the router stack lives on `app._router.stack`; building the app populates it.
  const router = (app as unknown as { _router?: { stack?: RouteLayer[] } })._router;
  const stack = router?.stack ?? [];
  const unguarded: string[] = [];

  for (const layer of stack) {
    const route = layer.route;
    if (!route) continue; // app-level middleware, not a mounted route
    for (const path of routePaths(route.path)) {
      if (path === '*') continue; // Express/Inversify terminal fallback, not an application route.
      if (publicPaths.some((p) => path.startsWith(p))) continue;
      const guarded = (route.stack ?? []).some((s) => isGuard(s.handle));
      if (!guarded) {
        const methods = route.methods
          ? Object.keys(route.methods)
              .filter((m) => route.methods?.[m])
              .map((m) => m.toUpperCase())
              .join(',')
          : 'ALL';
        unguarded.push(`${methods} ${path}`);
      }
    }
  }
  return unguarded;
}

/**
 * Boot-time, fail-closed assertion that every registered non-public route carries an
 * `authenticate()`/`authorize()` guard. Call AFTER the app is built (routes registered) and BEFORE it
 * starts listening. If any non-`/health` (and other public-prefixed) route has no tagged guard in its
 * handler stack, this THROWS — so a forgotten guard can never ship to production. Pass `collectOnly`
 * to get the list back instead of throwing (tests/diagnostics).
 *
 * NOTE: the access-control PEP must wrap its guards with {@link markAuthGuard} for them to be
 * recognised; an untagged custom guard will be reported as unguarded (fail-closed by design).
 */
export function assertPepBeforeRoutes(app: Application, opts: PepAssertionOptions = {}): string[] {
  const unguarded = findUnguardedRoutes(app, opts);
  if (opts.collectOnly) return unguarded;
  if (unguarded.length > 0) {
    throw new Error(
      `PEP assertion failed: ${unguarded.length} non-public route(s) are missing an ` +
        `authenticate()/authorize() guard (fail-closed). Offending routes:\n  ${unguarded.join('\n  ')}`,
    );
  }
  return unguarded;
}
