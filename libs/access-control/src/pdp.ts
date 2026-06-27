import type { AccessShape } from '@aegis/shared-types';
import { conditionsMatch } from './condition-evaluator';
import { checkRowScope } from './scope';

/**
 * Policy Decision Point — the ABAC + tenant-isolation + row-level-scope evaluator that complements
 * Casbin. In v2 the RBAC "does this role hold this permission in this tenant?" question is answered
 * by the Casbin enforcer at the PEP (`authorize` → `enforce`). `decide` remains the pure,
 * fail-closed evaluator for the layers Casbin does NOT cover:
 *   - tenant isolation (resource tenant must match principal tenant)
 *   - row-level scope (AllRecords / OwnAndTeam / OwnOnly) — via the shared `checkRowScope` helper
 *   - ABAC policies (deny-overrides; if allow-policies exist for the action, one must match)
 * It still performs the RBAC permission-membership check against `principal.permissions` so it
 * stays a self-contained decision (back-compatible), but the authoritative RBAC gate is Casbin.
 * See docs/03-access-control-model.md.
 */
export function decide(
  req: AccessShape.AccessRequest,
  policies: AccessShape.PolicyRule[] = [],
): AccessShape.AccessDecision {
  const perms = req.principal.permissions ?? [];

  // 1. RBAC — the permission must be granted by the principal's roles.
  if (!perms.includes(req.action)) {
    return { allow: false, reason: `permission '${req.action}' not granted to principal` };
  }

  // 2. Tenant isolation — never allow acting on another tenant's resource.
  if (req.resource?.tenantId && req.resource.tenantId !== req.principal.tenantId) {
    return { allow: false, reason: 'cross-tenant access denied' };
  }

  // 3. Deny-overrides: any matching deny policy wins.
  for (const p of policies) {
    if (p.effect === 'deny' && (p.action === req.action || p.action === '*') && conditionsMatch(p.conditions, req)) {
      return { allow: false, reason: `denied by policy ${p.id}` };
    }
  }

  // 4. Row-level scope (separate, reusable layer — also enforced as a PEP helper).
  const scopeResult = checkRowScope(req.principal, req.resource);
  if (!scopeResult.ok) {
    return { allow: false, reason: scopeResult.reason ?? 'row-level scope denied' };
  }

  // 5. ABAC allow-policies: if the action has allow-policies, at least one must match.
  const allowPolicies = policies.filter((p) => p.effect === 'allow' && p.action === req.action);
  if (allowPolicies.length > 0 && !allowPolicies.some((p) => conditionsMatch(p.conditions, req))) {
    return { allow: false, reason: 'no allow-policy condition matched' };
  }

  // 6. Obligations (e.g. column masking) attached by matching allow-policies handled at PEP.
  return { allow: true, reason: 'granted' };
}

/**
 * ABAC + tenant-isolation + row-scope evaluator for the **Casbin-authoritative** path (W5-04).
 *
 * `decide()` above re-checks RBAC membership against `principal.permissions` for back-compat. In v2
 * the RBAC gate is Casbin (run at the PEP BEFORE this), and the principal may carry NO `permissions`
 * array — so calling `decide()` would wrongly short-circuit before any ABAC policy ran. This variant
 * assumes the RBAC gate already PASSED and evaluates only the layers Casbin doesn't cover:
 *   - tenant isolation (resource.tenantId must match principal.tenantId)
 *   - deny-overrides (any matching deny policy wins — e.g. an over-cap approval)
 *   - row-level scope
 *   - allow-policy gating: if allow-policies exist for the action, at least one must match
 *   - obligations from the matching allow-policies (e.g. column masking)
 * Pure + fail-closed, identical operators/semantics to `decide()` minus the RBAC step.
 */
export function evaluateAbac(
  req: AccessShape.AccessRequest,
  policies: AccessShape.PolicyRule[] = [],
): AccessShape.AccessDecision {
  // Tenant isolation — never allow acting on another tenant's resource.
  if (req.resource?.tenantId && req.resource.tenantId !== req.principal.tenantId) {
    return { allow: false, reason: 'cross-tenant access denied' };
  }

  // Deny-overrides: any matching deny policy wins (e.g. amount-cap exceeded).
  for (const p of policies) {
    if (p.effect === 'deny' && (p.action === req.action || p.action === '*') && conditionsMatch(p.conditions, req)) {
      return { allow: false, reason: `denied by policy ${p.id}` };
    }
  }

  // Row-level scope.
  const scopeResult = checkRowScope(req.principal, req.resource);
  if (!scopeResult.ok) {
    return { allow: false, reason: scopeResult.reason ?? 'row-level scope denied' };
  }

  // Allow-policy gating: if the action carries allow-policies, at least one condition must match.
  const allowPolicies = policies.filter((p) => p.effect === 'allow' && (p.action === req.action || p.action === '*'));
  const matchingAllow = allowPolicies.filter((p) => conditionsMatch(p.conditions, req));
  if (allowPolicies.length > 0 && matchingAllow.length === 0) {
    return { allow: false, reason: 'no allow-policy condition matched' };
  }

  return { allow: true, reason: 'granted' };
}
