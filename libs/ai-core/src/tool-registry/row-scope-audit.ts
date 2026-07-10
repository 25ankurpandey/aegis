import type { Application } from 'express';
import { readPermissions } from '@aegis/service-core';

/**
 * @aegis/ai-core / tool-registry — the ROW-SCOPE AUDIT check.
 *
 * A sibling of the CI drift gate ({@link validateToolRegistry}), but for a DIFFERENT governance floor:
 * the T25 audit proved every guarded route is authz-bound (RBAC); this proves the *row-level* layer is
 * present on the routes that need it. A single-resource route (a GET/PATCH/PUT/POST/DELETE on a
 * `/:id`-style path) that acts on a TENANT-OWNED record — one with an owner/team — must run row-scope:
 * either via `authorize(perm, { resource: loader })` (so `checkRowScope` fires in the PEP) or, for a
 * repo that filters by owner/team in the query, an equivalent owner-scoped read. Otherwise an
 * `own_only` / `own_and_team` principal could reach a peer's row inside the same tenant (RLS only bounds
 * the TENANT, not the row).
 *
 * This module derives that verdict STRUCTURALLY from the same route metadata the tool registry already
 * reads (method, path, the stamped permission) — plus two optional flags a caller can supply when it has
 * richer knowledge (a stamped/known resource loader, or a repo-level owner filter). It is PURE,
 * DETERMINISTIC and DEPENDENCY-FREE beyond the metadata reader: the same input always yields a deep-equal
 * result, in a stable order, with no network / clock / mutation.
 *
 * IMPORTANT — what a walk CAN and CANNOT see. The `resource:` loader handed to `authorize()` is captured
 * inside that guard's closure and is NOT stamped onto the handler, so a pure router walk cannot observe
 * it. Therefore, when auditing a live app, a flagged route is a CANDIDATE that a human/AST pass must
 * confirm; it is not proof of a vulnerability. Callers that DO know the loader/filter state (e.g. a static
 * controller scan) pass `hasResourceLoader` / `hasOwnerScopedRepo` per route to get a definitive verdict.
 */

/** HTTP methods that address a single resource when combined with an id path param. */
const SINGLE_RESOURCE_METHODS = new Set(['GET', 'PATCH', 'PUT', 'POST', 'DELETE']);

/**
 * Permission prefixes/verbs that denote an ADMIN / tenant-global surface rather than a per-user owned
 * record. Routes guarded ONLY by these are tenant-scoped administration (identity, policy, tenant config,
 * team/tag governance, connector config) — RLS + RBAC already bound them to the tenant and there is no
 * per-row owner to scope against, so they are NOT row-scope gaps. Matched against the dotted permission
 * string (see Permission enum, e.g. `role.assign`, `tenant.manage`, `policy.manage`).
 */
const ADMIN_PERMISSION_PREFIXES = [
  'tenant.',
  'user.',
  'session.',
  'role.',
  'permission.',
  'policy.',
  'team.',
  'org.',
  'tag.',
  'record.',
  'connector.',
  'audit.',
];

/** A path segment that names a single resource id, e.g. `/:id`, `/:runId`, `/:teamId`. */
const ID_PARAM_SEGMENT = /\/:[A-Za-z0-9_]+/;

/**
 * A route as the audit sees it. `permissions` is the stamped `authorize()` permission(s); the two
 * optional flags let a richer caller (static scan / explicit knowledge) declare that the route DOES run
 * row-scope so it is not flagged.
 */
export interface AuditRoute {
  method: string;
  path: string;
  /** The permission(s) the route requires (from the `authorize()` stamp). Empty ⇒ not a tool, skipped. */
  permissions: string[];
  /**
   * True when the route is known to pass a `resource:` loader to `authorize()` (so `checkRowScope`
   * runs in the PEP). Undefined/false ⇒ unknown from a pure walk (treated as "not observed").
   */
  hasResourceLoader?: boolean;
  /**
   * True when the route's service/repo is known to filter the single-resource read by owner/team (the
   * notification-inbox pattern: `findByIdForUser(id, userId)`), which is an equivalent row-scope. Only a
   * caller with service/repo knowledge (a static scan) can set this.
   */
  hasOwnerScopedRepo?: boolean;
}

/** The kind of row-scope finding for one route. `ok` means row-scope is present (not a gap). */
export type RowScopeVerdict =
  | 'ok'
  | 'no_resource_loader'
  | 'candidate_no_resource_loader';

/** One row-scope finding: a single-resource, owned-resource route and whether it carries row-scope. */
export interface RowScopeGap {
  method: string;
  path: string;
  permissions: string[];
  verdict: RowScopeVerdict;
  /** Human-readable explanation of the verdict. */
  reason: string;
}

export interface AuditRowScopeOptions {
  /** Route path prefixes to skip (infra surface). Default: the public/non-tool prefixes. */
  excludePaths?: string[];
  /**
   * Extra permission prefixes to treat as ADMIN / tenant-global (not owned-resource), on top of the
   * built-in set. Lets a service opt a bespoke permission out of the owned-resource classification.
   */
  adminPermissionPrefixes?: string[];
}

const DEFAULT_EXCLUDE = ['/health', '/api-docs', '/.well-known', '/favicon.ico'];

/** Is EVERY guarding permission an admin / tenant-global one? Then the route is not an owned resource. */
function isAdminOnly(permissions: string[], adminPrefixes: string[]): boolean {
  return permissions.length > 0 && permissions.every((p) => adminPrefixes.some((a) => p.startsWith(a)));
}

/** A single-resource route: a mutating/reading method on a path that carries an id param segment. */
function isSingleResourceRoute(route: AuditRoute): boolean {
  return SINGLE_RESOURCE_METHODS.has(route.method.toUpperCase()) && ID_PARAM_SEGMENT.test(route.path);
}

/**
 * Audit a set of routes (or a built Express app) for MISSING row-scope on single-resource, owned-resource
 * routes. Returns one {@link RowScopeGap} per single-resource owned-resource route, most-actionable last is
 * NOT reordered — findings come back in INPUT ORDER for determinism. A route is:
 *
 *   - SKIPPED entirely (no finding) when: it is under an excluded prefix, it carries no permission (not a
 *     tool / internal-auth only), it is not a single-resource route (`/:id`-less collection route), or it
 *     is guarded ONLY by admin / tenant-global permissions (no per-row owner to scope against).
 *   - `ok` when it declares a resource loader (`hasResourceLoader`) OR an owner-scoped repo read
 *     (`hasOwnerScopedRepo`).
 *   - `no_resource_loader` when the caller definitively knows there is NO loader and NO owner-scoped repo
 *     (both flags present-and-false) — a confirmed gap.
 *   - `candidate_no_resource_loader` when neither flag was supplied (a pure walk cannot see the
 *     closure-captured loader) — a candidate for a human/AST pass to confirm.
 *
 * Accepts a plain {@link AuditRoute}[] (offline, unit-testable) or an Express `Application` (walked the
 * same way the tool-registry generator walks it).
 */
export function auditRowScope(
  input: Application | AuditRoute[],
  opts: AuditRowScopeOptions = {},
): RowScopeGap[] {
  const exclude = opts.excludePaths ?? DEFAULT_EXCLUDE;
  const adminPrefixes = [...ADMIN_PERMISSION_PREFIXES, ...(opts.adminPermissionPrefixes ?? [])];
  const routes = Array.isArray(input) ? input : routesFromApp(input);
  const gaps: RowScopeGap[] = [];

  for (const route of routes) {
    const path = route.path;
    if (exclude.some((p) => path.startsWith(p))) continue;
    if (!route.permissions || route.permissions.length === 0) continue; // not authz-bound ⇒ not a tool
    if (!isSingleResourceRoute(route)) continue; // collection / non-id route ⇒ list-filter's job
    if (isAdminOnly(route.permissions, adminPrefixes)) continue; // tenant-global admin ⇒ no row owner

    let verdict: RowScopeVerdict;
    let reason: string;
    if (route.hasResourceLoader === true) {
      verdict = 'ok';
      reason = 'passes a resource loader to authorize() — checkRowScope runs in the PEP.';
    } else if (route.hasOwnerScopedRepo === true) {
      verdict = 'ok';
      reason = 'service/repo filters the single-resource read by owner/team (equivalent row-scope).';
    } else if (route.hasResourceLoader === false || route.hasOwnerScopedRepo === false) {
      // Caller definitively knows there is no loader AND no owner-scoped repo.
      verdict = 'no_resource_loader';
      reason =
        'owned-resource /:id route with NO resource loader and NO owner-scoped repo read — an own_only/own_and_team principal could reach a peer row (RLS only bounds the tenant).';
    } else {
      verdict = 'candidate_no_resource_loader';
      reason =
        'owned-resource /:id route with no resource loader observed on the router walk (the loader, if any, is closure-captured) — confirm with a controller/service read.';
    }

    gaps.push({
      method: route.method.toUpperCase(),
      path,
      permissions: route.permissions,
      verdict,
      reason,
    });
  }

  return gaps;
}

/** Only the genuine + candidate gaps (drops `ok`) — convenience for a report/CI gate. */
export function rowScopeGapsOnly(gaps: RowScopeGap[]): RowScopeGap[] {
  return gaps.filter((g) => g.verdict !== 'ok');
}

interface RouteLayer {
  route?: {
    path: string | string[];
    methods?: Record<string, boolean>;
    stack?: Array<{ handle?: unknown }>;
  };
}

/**
 * Recover {@link AuditRoute}[] from a built Express app by walking `app._router.stack` — the same walk the
 * tool-registry generator uses. Only the stamped permission is recoverable from a walk; the resource
 * loader is closure-captured and therefore left undefined (⇒ `candidate_*` verdicts).
 */
function routesFromApp(app: Application): AuditRoute[] {
  const stack = (app as unknown as { _router?: { stack?: RouteLayer[] } })._router?.stack ?? [];
  const routes: AuditRoute[] = [];
  for (const layer of stack) {
    const route = layer.route;
    if (!route) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    for (const path of paths) {
      if (path === '*') continue;
      let permissions: string[] | undefined;
      for (const s of route.stack ?? []) {
        const p = readPermissions(s.handle);
        if (p && !permissions) permissions = p;
      }
      if (!permissions || permissions.length === 0) continue;
      const methods = route.methods
        ? Object.keys(route.methods).filter((m) => route.methods?.[m])
        : ['all'];
      for (const method of methods) {
        routes.push({ method: method.toUpperCase(), path, permissions });
      }
    }
  }
  return routes;
}
