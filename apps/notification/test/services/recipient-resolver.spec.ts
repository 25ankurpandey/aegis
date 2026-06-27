import { HttpClient } from '@aegis/service-core';
import type { NotificationShape } from '@aegis/shared-types';
import { RecipientResolverService } from '../../src/services/recipient-resolver.service';

/**
 * W3-09: the resolver turns an event's recipient HINT into the concrete recipient SET to fan out to.
 * It trusts an inline address, resolves a bare userId against user-management, and degrades to
 * in-app-only (or an empty audience) when the lookup is unavailable — never dropping the whole event.
 */
describe('RecipientResolverService', () => {
  let resolver: RecipientResolverService;

  beforeEach(() => {
    resolver = new RecipientResolverService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('trusts an inline email on a user spec without calling user-management', async () => {
    const spy = jest.spyOn(HttpClient, 'call');
    const out = await resolver.resolve({ kind: 'user', userId: 'u1', email: 'u1@x.com' });
    expect(out).toEqual([{ userId: 'u1', email: 'u1@x.com', phone: undefined }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves a bare userId to email/phone via user-management', async () => {
    jest
      .spyOn(HttpClient, 'call')
      .mockResolvedValue({ userId: 'u2', email: 'u2@x.com', phone: '+15551234567' } as never);
    const out = await resolver.resolve({ kind: 'user', userId: 'u2' });
    expect(out).toEqual([{ userId: 'u2', email: 'u2@x.com', phone: '+15551234567' }]);
  });

  it('degrades to in-app-only when the user contact lookup fails', async () => {
    jest.spyOn(HttpClient, 'call').mockRejectedValue(new Error('down'));
    const out = await resolver.resolve({ kind: 'user', userId: 'u3' });
    expect(out).toEqual([{ userId: 'u3' }]);
  });

  it('fans out an audience (role) to its resolved members', async () => {
    const members: NotificationShape.ResolvedUserContact[] = [
      { userId: 'a', email: 'a@x.com' },
      { userId: 'b', phone: '+1999' },
    ];
    jest.spyOn(HttpClient, 'call').mockResolvedValue(members as never);
    const out = await resolver.resolve({ kind: 'role', role: 'admin' });
    expect(out).toEqual([
      { userId: 'a', email: 'a@x.com', phone: undefined },
      { userId: 'b', email: undefined, phone: '+1999' },
    ]);
  });

  it('returns an empty set when an audience lookup is unavailable', async () => {
    jest.spyOn(HttpClient, 'call').mockRejectedValue(new Error('no endpoint'));
    const out = await resolver.resolve({ kind: 'tenant-admins' });
    expect(out).toEqual([]);
  });
});
