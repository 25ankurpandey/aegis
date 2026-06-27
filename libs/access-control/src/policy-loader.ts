import type { Permission } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';

/**
 * ABAC policy loaders for `authorize({ policies })` (W5-04).
 *
 * `authorize()` only runs the ABAC/PDP layer when a route supplies a `policies:` loader. Until now no
 * route did, so SPEC §2.3/§2.5 ABAC (amount caps, manager scope, column masking) was dormant. These
 * loaders turn applicable policies into the `AccessShape.PolicyRule[]` the PDP evaluates, so the gate
 * actually enforces them.
 *
 * A loader receives the authenticated `principal` and the loaded `resource` (from the route's
 * `resource:` loader) and returns the rules to evaluate. Loaders are PURE and synchronous-friendly
 * (may return a Promise) so they compose; the heavy "fetch policies from the DB" case is just an
 * async loader. The reference here is the **amount cap**: "an approver may approve a report only up to
 * their approval limit", expressed as a deny-override that fires when the resource amount exceeds the
 * cap — deny-overrides win in the PDP, so an over-cap approval is refused even though Casbin RBAC
 * granted the `approve` permission.
 *
 * ADOPT IT ON A ROUTE (the documented one-liner):
 *
 *   authorize(Permission.ExpenseReportApprove, {
 *     resource: (req) => loadReportResource(req),
 *     policies: amountCapPolicies(Permission.ExpenseReportApprove),
 *   })
 *
 * Other sensitive routes (invoice approve, payroll sensitive read) adopt ABAC the same way — point a
 * `policies:` loader at the rules that apply to them. A DB-backed loader (policies persisted via the
 * PAP) plugs in by returning the fetched rules from an async function with the same signature.
 */

/** The principal attribute carrying a per-approver amount cap (minor units), set on the JWT/claims. */
export const APPROVAL_LIMIT_ATTR = 'approvalLimit';

/** Resource attribute holding the amount under decision (minor units), set by the resource loader. */
export const RESOURCE_AMOUNT_ATTR = 'amount';

/** A `policies` loader, matching `AuthorizeOptions.policies`. */
export type PolicyLoader = (
  principal: AccessShape.Principal,
  resource?: AccessShape.ResourceRef,
) => AccessShape.PolicyRule[] | Promise<AccessShape.PolicyRule[]>;

/** Read a numeric attribute from a bag, tolerating string-encoded numbers; undefined when absent/NaN. */
function readNumber(bag: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!bag || bag[key] == null) return undefined;
  const n = typeof bag[key] === 'number' ? (bag[key] as number) : Number(bag[key]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Amount-cap ABAC loader (W5-04 reference). Emits a single deny-override policy for `action` when the
 * principal has a finite `approvalLimit` attribute: the policy denies once `resource.amount` exceeds
 * the cap. No cap on the principal ⇒ no policy ⇒ the PDP's allow-policy gate stays vacuous and RBAC
 * alone decides (back-compat: an unconfigured approver is not newly blocked). A resource with no
 * amount never trips the `gt` comparison, so non-amount routes are unaffected.
 *
 * Returns a loader so it reads the cap at REQUEST time (per-principal, per-resource), not at wiring
 * time — the cap can come from the JWT today and a tenant-config/DB lookup later without touching the
 * route.
 */
export function amountCapPolicies(action: Permission): PolicyLoader {
  return (principal) => {
    const cap = readNumber(principal.attributes, APPROVAL_LIMIT_ATTR);
    if (cap === undefined) return [];
    return [
      {
        id: `amount-cap:${action}:${cap}`,
        effect: 'deny',
        action,
        conditions: [{ attribute: `resource.${RESOURCE_AMOUNT_ATTR}`, operator: 'gt', value: cap }],
      },
    ];
  };
}

/**
 * Compose several policy loaders into one (concatenates their rules). Lets a route layer, say, an
 * amount-cap deny with a column-mask allow-obligation without nesting.
 */
export function combinePolicies(...loaders: PolicyLoader[]): PolicyLoader {
  return async (principal, resource) => {
    const all = await Promise.all(loaders.map((l) => l(principal, resource)));
    return all.flat();
  };
}
