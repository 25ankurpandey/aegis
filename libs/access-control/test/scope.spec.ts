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
  it('AllRecords or no scope allows any resource', () => {
    expect(checkRowScope(principal({ scope: Scope.AllRecords }), { type: 'r', ownerId: 'x' }).ok).toBe(true);
    expect(checkRowScope(principal(), { type: 'r', ownerId: 'x' }).ok).toBe(true);
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
