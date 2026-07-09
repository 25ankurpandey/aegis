import type { AccessShape } from '@aegis/shared-types';
import { Scope } from '@aegis/shared-enums';

/**
 * Row-level scope check — a SEPARATE layer from Casbin RBAC. Casbin answers "does this role hold
 * this permission in this tenant?"; this answers "is this specific row visible to this principal?"
 * (AllRecords / OwnAndTeam / OwnOnly). Kept out of the policy engine deliberately: row visibility
 * is data-shaped and is also backstopped by Postgres RLS. Pure + fail-closed.
 *
 * Returns `{ ok: true }` when the principal may act on the resource under their scope, or
 * `{ ok: false, reason }` otherwise. A request with no resource (collection-level) is allowed
 * here; row filtering for list endpoints is compiled into query predicates + RLS.
 *
 * FAIL-CLOSED (SCOPE-05): a MISSING scope claim degrades to the most restrictive (`own_only`), never
 * to allow-all, and an UNRECOGNIZED scope value is DENIED — so a malformed/legacy token can never
 * silently grant tenant-wide visibility. Only an explicit `all` scope skips the row check.
 */
export function checkRowScope(
  principal: AccessShape.Principal,
  resource?: AccessShape.ResourceRef,
): { ok: boolean; reason?: string } {
  // Collection-level (no single resource): row filtering is compiled into query predicates + RLS.
  if (!resource) {
    return { ok: true };
  }

  const scope = principal.scope;
  if (scope === Scope.AllRecords) {
    return { ok: true };
  }

  // Missing scope => most restrictive, not permissive.
  const effective = scope ?? Scope.OwnOnly;

  if (effective === Scope.OwnOnly) {
    if (resource.ownerId !== principal.userId) {
      return { ok: false, reason: 'own-only scope: not the owner' };
    }
    return { ok: true };
  }

  if (effective === Scope.OwnAndTeam) {
    const isOwner = resource.ownerId === principal.userId;
    const teamIds = (principal.attributes?.['teamIds'] as string[] | undefined) ?? [];
    const inTeam = resource.teamId != null && teamIds.includes(resource.teamId);
    if (!isOwner && !inTeam) {
      return { ok: false, reason: 'own-and-team scope: not owner or team member' };
    }
    return { ok: true };
  }

  // Unrecognized scope value => fail-closed (deny), never fall through to allow.
  return { ok: false, reason: `unrecognized scope "${String(scope)}": fail-closed` };
}
