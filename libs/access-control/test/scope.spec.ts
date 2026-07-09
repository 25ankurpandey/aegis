import { checkRowScope } from '../src/scope';
import { Scope } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';

const principal = (over: Partial<AccessShape.Principal> = {}): AccessShape.Principal => ({
  userId: 'u1',
  tenantId: 't1',
  roles: [],
  attributes: { teamIds: ['teamA'] },
  ...over,
});

describe('checkRowScope() — row-level visibility (separate from Casbin)', () => {
  it('AllRecords allows any resource', () => {
    expect(checkRowScope(principal({ scope: Scope.AllRecords }), { type: 'r', ownerId: 'x' }).ok).toBe(true);
  });

  it('a MISSING scope claim FAIL-CLOSES to own-only (SCOPE-05), not allow-all', () => {
    // not the owner → denied
    expect(checkRowScope(principal(), { type: 'r', ownerId: 'x' }).ok).toBe(false);
    // the owner → allowed
    expect(checkRowScope(principal(), { type: 'r', ownerId: 'u1' }).ok).toBe(true);
  });

  it('an UNRECOGNIZED scope value is DENIED (fail-closed), never allowed', () => {
    expect(
      checkRowScope(principal({ scope: 'bogus_scope' as unknown as Scope }), { type: 'r', ownerId: 'u1' }).ok,
    ).toBe(false);
  });

  it('no resource (collection-level) is allowed', () => {
    expect(checkRowScope(principal({ scope: Scope.OwnOnly }), undefined).ok).toBe(true);
  });

  it('OwnOnly allows the owner and denies others', () => {
    expect(checkRowScope(principal({ scope: Scope.OwnOnly }), { type: 'r', ownerId: 'u1' }).ok).toBe(true);
    const denied = checkRowScope(principal({ scope: Scope.OwnOnly }), { type: 'r', ownerId: 'u2' });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/own-only/);
  });

  it('OwnAndTeam allows owner or team member, denies outsiders', () => {
    expect(checkRowScope(principal({ scope: Scope.OwnAndTeam }), { type: 'r', ownerId: 'u1' }).ok).toBe(true);
    expect(checkRowScope(principal({ scope: Scope.OwnAndTeam }), { type: 'r', ownerId: 'u9', teamId: 'teamA' }).ok).toBe(true);
    const denied = checkRowScope(principal({ scope: Scope.OwnAndTeam }), { type: 'r', ownerId: 'u9', teamId: 'teamZ' });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/own-and-team/);
  });
});
