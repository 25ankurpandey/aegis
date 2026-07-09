import { RequestContext } from '@aegis/service-core';
import { Scope } from '@aegis/shared-enums';
import { rowScopeListFilter } from '../src/row-scope-filter';

/** Run `fn` inside a RequestContext seeded with the given principal fields. */
function inCtx<T>(over: Record<string, unknown>, fn: () => T): T {
  return RequestContext.run(
    { tenantId: 't1', correlationId: 'c', startedAt: 0, userId: 'u1', ...over } as never,
    fn,
  );
}

describe('rowScopeListFilter — list-route row scope from the signed scope claim', () => {
  it('all → no restriction', () => {
    inCtx({ scope: Scope.AllRecords }, () => {
      expect(rowScopeListFilter()).toEqual({ scope: 'all', teamIds: [] });
    });
  });

  it('own_only → own (owner = the caller)', () => {
    inCtx({ scope: Scope.OwnOnly }, () => {
      expect(rowScopeListFilter()).toEqual({ scope: 'own', userId: 'u1', teamIds: [] });
    });
  });

  it('own_and_team → carries the PIP team ids', () => {
    inCtx({ scope: Scope.OwnAndTeam, teamIds: ['teamA', 'teamB'] }, () => {
      expect(rowScopeListFilter()).toEqual({
        scope: 'own_and_team',
        userId: 'u1',
        teamIds: ['teamA', 'teamB'],
      });
    });
  });

  it('a MISSING scope FAIL-CLOSES to own (not all)', () => {
    inCtx({}, () => {
      expect(rowScopeListFilter()).toEqual({ scope: 'own', userId: 'u1', teamIds: [] });
    });
  });

  it('an UNRECOGNIZED scope FAIL-CLOSES to own', () => {
    inCtx({ scope: 'bogus_scope' }, () => {
      expect(rowScopeListFilter().scope).toBe('own');
    });
  });
});
