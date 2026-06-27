import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Enforcer } from 'casbin';
import type { Permission } from '@aegis/shared-enums';
import { Scope } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';
import { Config, ErrUtils, RequestContext, markAuthGuard } from '@aegis/service-core';
import { Logger } from '@aegis/service-core';
import { decide, evaluateAbac } from './pdp';
import { createEnforcer, enforce } from './enforcer';
import { invalidatePolicies, startPolicyWatcher } from './watcher';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: AccessShape.Principal;
    }
  }
}

interface AegisJwtClaims {
  sub: string;
  tenant_id: string;
  roles?: string[];
  permissions?: Permission[];
  scope?: Scope;
  attributes?: Record<string, unknown>;
}

/**
 * Authentication PEP: verifies the bearer JWT, asserts the token's tenant matches the
 * request tenant (defence-in-depth), and populates `req.principal` + the request context.
 * Local uses an HS256 shared secret; production swaps to RS256/JWKS at this seam.
 */
export function authenticate(): RequestHandler {
  return markAuthGuard((req, _res, next) => {
    const token = RequestContext.token();
    if (!token) {
      return next(ErrUtils.unauthorized('Missing bearer token'));
    }
    let claims: AegisJwtClaims;
    try {
      claims = jwt.verify(token, Config.require('AUTH_JWT_SECRET')) as AegisJwtClaims;
    } catch {
      return next(ErrUtils.unauthorized('Invalid or expired token'));
    }

    const headerTenant = RequestContext.tenantId();
    if (claims.tenant_id !== headerTenant) {
      return next(ErrUtils.forbidden('Token tenant does not match request tenant'));
    }

    const principal: AccessShape.Principal = {
      userId: claims.sub,
      tenantId: claims.tenant_id,
      roles: claims.roles ?? [],
      permissions: claims.permissions ?? [],
      scope: claims.scope,
      attributes: claims.attributes,
    };
    req.principal = principal;
    RequestContext.set('userId', principal.userId);
    RequestContext.set('roles', principal.roles);
    return next();
  });
}

/**
 * Process-wide Casbin enforcer, built once and reused (loading policy per-request would be too
 * costly). Tests/bootstraps can inject an in-memory enforcer via `setEnforcer`.
 */
let enforcerPromise: Promise<Enforcer> | undefined;
let enforcerFactory: () => Promise<Enforcer> = createEnforcer;
let policyOperation: Promise<void> = Promise.resolve();

async function withPolicyOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = policyOperation;
  let release!: () => void;
  policyOperation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Override the enforcer factory (e.g. an in-memory enforcer in tests / no-DB local runs). */
export function setEnforcerFactory(factory: () => Promise<Enforcer>): void {
  enforcerFactory = factory;
  enforcerPromise = undefined;
}

/** Inject a ready enforcer instance directly (e.g. tests). */
export function setEnforcer(enforcer: Enforcer): void {
  enforcerPromise = Promise.resolve(enforcer);
}

/** Reset the cached enforcer (mainly for tests). */
export function resetEnforcer(): void {
  enforcerPromise = undefined;
  enforcerFactory = createEnforcer;
  policyOperation = Promise.resolve();
}

async function getEnforcer(): Promise<Enforcer> {
  if (!enforcerPromise) {
    enforcerPromise = enforcerFactory();
  }
  return enforcerPromise;
}

/**
 * Reload this pod's enforcer from the policy store (W5-03). Called by the Redis watcher on every
 * inbound invalidation, and directly by the PAP on the writer pod so its own next request is correct.
 *
 * FAIL-CLOSED: if `loadPolicy()` throws, we DROP the in-memory policy (`clearPolicy`) so the pod
 * denies every request until a subsequent reload succeeds — we never keep serving a possibly stale /
 * over-permissive snapshot. A no-op when no enforcer has been built yet (nothing to refresh).
 */
export async function reloadEnforcer(): Promise<void> {
  const currentPromise = enforcerPromise;
  if (!currentPromise) return; // enforcer not built yet — first request will load fresh.
  await withPolicyOperation(async () => {
    let enforcer: Enforcer;
    try {
      enforcer = await currentPromise;
    } catch {
      // The cached build itself failed; reset so the next request rebuilds from scratch.
      enforcerPromise = undefined;
      return;
    }
    try {
      await enforcer.loadPolicy();
    } catch (err) {
      Logger.error(err as Error, 'ENFORCER_RELOAD_FAILED', 'ACCESS_CONTROL');
      try {
        await enforcer.clearPolicy(); // fail-closed: deny until a healthy reload lands.
      } catch {
        /* even clear failed — leave as-is; getEnforcer errors already fail closed at the gate. */
      }
      throw err;
    }
  });
}

/**
 * Start the cross-pod policy watcher and bind it to `reloadEnforcer`. Call once at service bootstrap
 * (after `CacheAdapter`/config are ready). Idempotent + fail-open (see `startPolicyWatcher`).
 */
export async function initPolicyReload(): Promise<void> {
  await startPolicyWatcher(reloadEnforcer);
}

/** A role→permission (p) or user→role (g) grant to project into the live policy store. */
export interface PolicyGrant {
  /** p-rules: role/user `sub` is allowed `act` (permission) in tenant `dom` (or '*'). */
  permissions?: Array<{ sub: string; dom: string; act: string }>;
  /** g-rules to ADD: `user` has `role` in tenant `dom`. */
  groupings?: Array<{ user: string; role: string; dom: string }>;
  /**
   * g-rules to REMOVE: `user` no longer has `role` in tenant `dom` (e.g. the PRIOR role on a
   * re-assignment). Revocations are applied BEFORE additions so a re-assignment never transiently
   * grants both roles, and so a revoke failure aborts the whole projection (fail-closed: BUG-0008).
   */
  revokeGroupings?: Array<{ user: string; role: string; dom: string }>;
}

/**
 * Project a PAP grant into the running enforcer + persistent policy store, then fan out an
 * invalidation so every OTHER pod reloads (W5-03). The relational role/permission catalog remains the
 * source of truth; this keeps the Casbin store (which the enforcer actually evaluates) in lockstep so
 * a freshly-created role / freshly-assigned user takes effect WITHOUT a restart.
 *
 * `addPolicy`/`addGroupingPolicy`/`removeGroupingPolicy` write through the enforcer's adapter (so the
 * change persists for the next cold load and for other pods' `loadPolicy()`) AND update this pod's
 * in-memory model — so the writer pod is immediately correct. Duplicate adds / absent removes are
 * ignored (Casbin returns false, no throw). FAIL-CLOSED on a write error: surfaced to the caller so
 * the PAP transaction can react.
 *
 * Order matters for a re-assignment (BUG-0008): REVOKE the stale grouping(s) FIRST, then ADD the new
 * grant. That way the user is never transiently a member of both roles, and a revoke failure throws
 * before any new grant is applied — the safe (fail-closed) direction.
 */
export async function applyPolicyGrant(grant: PolicyGrant): Promise<void> {
  await withPolicyOperation(async () => {
    const enforcer = await getEnforcer();
    for (const g of grant.revokeGroupings ?? []) {
      await enforcer.removeGroupingPolicy(g.user, g.role, g.dom);
    }
    for (const p of grant.permissions ?? []) {
      await enforcer.addPolicy(p.sub, p.dom, p.act, 'allow');
    }
    for (const g of grant.groupings ?? []) {
      await enforcer.addGroupingPolicy(g.user, g.role, g.dom);
    }
  });
  await invalidatePolicies();
}

export interface AuthorizeOptions {
  /** Load the resource being acted upon (for ABAC + row-level checks). */
  resource?: (req: Request) => AccessShape.ResourceRef | Promise<AccessShape.ResourceRef>;
  /** Supply applicable policies (from the PAP/DB). Defaults to none (RBAC-only). */
  policies?: (
    principal: AccessShape.Principal,
    resource?: AccessShape.ResourceRef,
  ) => AccessShape.PolicyRule[] | Promise<AccessShape.PolicyRule[]>;
}

async function firstAllowedAction(
  enforcer: Enforcer,
  subjects: string[],
  tenantId: string,
  actions: Permission[],
): Promise<Permission | null> {
  for (const action of actions) {
    for (const subject of subjects) {
      if (await enforce(enforcer, subject, tenantId, action)) {
        return action;
      }
    }
  }
  return null;
}

/**
 * Authorization PEP. Wrap every route as `authenticate(), authorize(Permission.X, {...})`.
 *
 * RBAC is now decided by **Casbin**: the principal's role(s) + tenant are resolved from the
 * request context/principal and checked with `enforce(role, tenantId, permission)`. The grant
 * holds if ANY of the principal's roles (or the user id itself, for direct user grants) is allowed
 * the permission in the request's tenant domain. Fail-closed: no roles, no enforcer, or any error
 * => 403.
 *
 * When a resource/policies are supplied, the ABAC + row-level-scope layers (the PDP `decide`) run
 * as a second gate so tenant isolation, deny-overrides, and row visibility still apply and
 * obligations (e.g. column masking) are placed on `res.locals.obligations`.
 */
export function authorize(action: Permission, opts: AuthorizeOptions = {}): RequestHandler {
  return authorizeAny([action], opts);
}

/** Authorization PEP variant for routes that accept one of several permissions. */
export function authorizeAny(actions: Permission[], opts: AuthorizeOptions = {}): RequestHandler {
  return markAuthGuard(async (req, res, next) => {
    try {
      const principal = req.principal;
      if (!principal) {
        return next(ErrUtils.unauthorized('Not authenticated'));
      }

      const tenantId = principal.tenantId;
      if (!tenantId) {
        return next(ErrUtils.forbidden('No tenant on principal'));
      }

      // 1. Casbin RBAC gate (dom = tenantId). Allow if any role OR the user id is granted.
      const subjects = [...(principal.roles ?? []), principal.userId].filter(Boolean) as string[];
      const allowedAction = await withPolicyOperation(async () => {
        const enforcer = await getEnforcer();
        return firstAllowedAction(enforcer, subjects, tenantId, actions);
      });
      if (!allowedAction) {
        return next(ErrUtils.forbidden(`none of [${actions.join(', ')}] granted in tenant`));
      }
      res.locals.authorizedPermission = allowedAction;

      // 2. ABAC + tenant-isolation + row-level scope (only when a resource/policies are involved).
      const resource = opts.resource ? await opts.resource(req) : undefined;
      const policies = opts.policies ? await opts.policies(principal, resource) : [];
      if (resource || policies.length > 0) {
        // Casbin already gated RBAC above, so we evaluate ONLY the ABAC/scope/tenant layers here.
        // `decide()` re-checks RBAC membership against principal.permissions for back-compat; when the
        // principal carries permissions we keep that path, otherwise (Casbin-only) we use evaluateAbac
        // so deny-overrides (e.g. amount caps) and allow-policy gating still run — previously they were
        // silently skipped for Casbin-only principals (W5-04).
        const decision =
          principal.permissions && principal.permissions.length > 0
            ? decide({ principal, action: allowedAction, resource }, policies)
            : evaluateAbac({ principal, action: allowedAction, resource }, policies);
        if (!decision.allow) {
          return next(ErrUtils.forbidden(decision.reason));
        }
        res.locals.obligations = decision.obligations ?? [];
        return next();
      }

      res.locals.obligations = res.locals.obligations ?? [];
      return next();
    } catch (err) {
      return next(err);
    }
  });
}
