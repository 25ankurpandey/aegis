import type { NotificationShape } from '@aegis/shared-types';
import { SenderIdentityService } from '../../src/services/sender-identity.service';
import type { EmailSenderIdentityRepository } from '../../src/repositories/email-sender-identity.repository';

/**
 * G2 — the sender-identity resolver turns a tenant's row into the concrete From / Reply-To + the
 * email master-switch, with a safe default when no row is configured.
 */
describe('SenderIdentityService.resolve', () => {
  const tx = {} as never;

  function row(
    over: Partial<NotificationShape.EmailSenderIdentityRow>,
  ): NotificationShape.EmailSenderIdentityRow {
    return {
      id: 'sid-1',
      tenant_id: 't1',
      from_name: null,
      from_email: null,
      reply_to: null,
      email_enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
      ...over,
    };
  }

  it('defaults to send-enabled with a null From when no row exists', async () => {
    const repo = { findForTenant: jest.fn().mockResolvedValue(null) } as unknown as EmailSenderIdentityRepository;
    const svc = new SenderIdentityService(repo);

    const id = await svc.resolve(tx);
    expect(id).toEqual({ from: null, replyTo: null, emailEnabled: true });
  });

  it('composes a display-name From when from_name + from_email are set', async () => {
    const repo = {
      findForTenant: jest.fn().mockResolvedValue(
        row({ from_name: 'Acme Billing', from_email: 'billing@acme.com', reply_to: 'support@acme.com' }),
      ),
    } as unknown as EmailSenderIdentityRepository;
    const svc = new SenderIdentityService(repo);

    const id = await svc.resolve(tx);
    expect(id).toEqual({
      from: '"Acme Billing" <billing@acme.com>',
      replyTo: 'support@acme.com',
      emailEnabled: true,
    });
  });

  it('uses a bare address when only from_email is set', async () => {
    const repo = {
      findForTenant: jest.fn().mockResolvedValue(row({ from_email: 'noreply@acme.com' })),
    } as unknown as EmailSenderIdentityRepository;
    const svc = new SenderIdentityService(repo);

    const id = await svc.resolve(tx);
    expect(id.from).toBe('noreply@acme.com');
  });

  it('reports the tenant master-switch as off when email_enabled is false', async () => {
    const repo = {
      findForTenant: jest.fn().mockResolvedValue(row({ email_enabled: false })),
    } as unknown as EmailSenderIdentityRepository;
    const svc = new SenderIdentityService(repo);

    const id = await svc.resolve(tx);
    expect(id.emailEnabled).toBe(false);
  });
});
