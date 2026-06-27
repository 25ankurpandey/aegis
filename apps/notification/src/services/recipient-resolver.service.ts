import { HttpClient, Logger } from '@aegis/service-core';
import { ServiceName } from '@aegis/shared-enums';
import type { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';

/**
 * RecipientResolver (W3-09 fan-out) — turns an event's recipient HINT into the concrete recipient
 * SET the consumer fans a notification out to. This fixes the gap where notifications had no real
 * recipient resolution beyond the single hint on the payload.
 *
 * Resolution strategy per spec kind:
 *  - `user`: the common case. If the hint already carries an email/phone, it is trusted as-is. If
 *    only a `userId` is known, a context-propagating GET to user-management resolves the contact
 *    (userId → email/phone). The call is best-effort: on any failure the user is still returned with
 *    no address so the IN-APP channel fans out (graceful degradation, never a dropped notification).
 *  - `role` / `group` / `tenant-admins`: addressing an audience the producer cannot enumerate. These
 *    delegate to user-management's membership lookup; the default below documents the contract and
 *    returns an empty set when the endpoint is unavailable (so the consumer simply fans out nothing
 *    for that audience rather than throwing). A deployment wires the real endpoint via env.
 *
 * The whole port is replaceable: bind a different `RecipientResolver` (e.g. an in-memory directory
 * for tests, or a cache-backed resolver) at composition without touching the consumer.
 */
@provideSingleton(RecipientResolverService)
export class RecipientResolverService implements NotificationShape.RecipientResolver {
  async resolve(spec: NotificationShape.RecipientSpec): Promise<NotificationShape.Recipient[]> {
    switch (spec.kind) {
      case 'user':
        return [await this.resolveUser(spec.userId, spec.email, spec.phone)];
      case 'role':
        return this.resolveAudience({ role: spec.role });
      case 'group':
        return this.resolveAudience({ groupId: spec.groupId });
      case 'tenant-admins':
        return this.resolveAudience({ tenantAdmins: true });
    }
  }

  /** Resolve a single user — trust an inline address, else look it up; degrade to in-app-only. */
  private async resolveUser(
    userId: string,
    email?: string,
    phone?: string,
  ): Promise<NotificationShape.Recipient> {
    if (email || phone) return { userId, email, phone };
    try {
      const contact = await HttpClient.call<NotificationShape.ResolvedUserContact>(
        ServiceName.UserManagement,
        { method: 'GET', path: `/user-management/internal/users/${userId}/contact` },
      );
      return { userId, email: contact.email, phone: contact.phone };
    } catch (err) {
      Logger.warn('recipient resolve: user contact lookup failed; in-app only', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { userId };
    }
  }

  /**
   * Resolve a role/group/tenant-admins audience to its member contacts. Documented contract against
   * user-management; returns an empty set (best-effort) when the lookup is unavailable so the
   * consumer fans out nothing for the audience instead of failing the whole event.
   */
  private async resolveAudience(query: {
    role?: string;
    groupId?: string;
    tenantAdmins?: boolean;
  }): Promise<NotificationShape.Recipient[]> {
    try {
      const members = await HttpClient.call<NotificationShape.ResolvedUserContact[]>(
        ServiceName.UserManagement,
        {
          method: 'GET',
          path: '/user-management/internal/recipients',
          query: {
            ...(query.role ? { role: query.role } : {}),
            ...(query.groupId ? { groupId: query.groupId } : {}),
            ...(query.tenantAdmins ? { tenantAdmins: 'true' } : {}),
          },
        },
      );
      return members.map((m) => ({ userId: m.userId, email: m.email, phone: m.phone }));
    } catch (err) {
      Logger.warn('recipient resolve: audience lookup unavailable; fanning out nothing', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
