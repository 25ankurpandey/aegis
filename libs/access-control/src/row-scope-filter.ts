import { RequestContext } from '@aegis/service-core';
import { Scope } from '@aegis/shared-enums';

/**
 * The LIST-route counterpart to {@link checkRowScope}. A collection endpoint has no single resource
 * for the PEP to gate, so the service must compile a row-visibility predicate into its query. This
 * helper resolves that predicate from the authenticated principal's scope claim + PIP team ids
 * (both surfaced onto the RequestContext by the PEP), so every service derives it identically and
 * from the SIGNED scope claim — never from role names (the ROWSCOPE-03 bug).
 *
 * FAIL-CLOSED, matching checkRowScope: a missing or unrecognized scope resolves to `own` (most
 * restrictive), never `all`. `own_and_team` carries the team ids so the repo can OR in a team match.
 */
export interface RowScopeListFilter {
  /** `all` → no row restriction; `own` → owner-only; `own_and_team` → owner OR one of `teamIds`. */
  scope: 'all' | 'own' | 'own_and_team';
  /** The principal's user id — the owner value to match for `own` / `own_and_team` (undefined only if unauthenticated). */
  userId?: string;
  /** The principal's team ids — the set to match for `own_and_team` (empty otherwise). */
  teamIds: string[];
}

/**
 * Resolve the list-scope filter for the current request. Read the `scope` field to branch:
 *   - `all`          → return every tenant row (RLS still bounds it to the tenant).
 *   - `own_and_team` → the repo should keep rows the principal owns OR whose team ∈ `teamIds`.
 *   - anything else  → `own` (fail-closed): keep only rows the principal owns.
 */
export function rowScopeListFilter(): RowScopeListFilter {
  const scope = RequestContext.scope();
  const userId = RequestContext.userId();

  if (scope === Scope.AllRecords) {
    return { scope: 'all', teamIds: [] };
  }
  if (scope === Scope.OwnAndTeam) {
    return { scope: 'own_and_team', userId, teamIds: RequestContext.teamIds() };
  }
  // own_only OR a missing/unrecognized scope → fail-closed to owner-only.
  return { scope: 'own', userId, teamIds: [] };
}
