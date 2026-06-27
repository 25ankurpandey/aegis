import nodemailer from 'nodemailer';
import type { NotificationShape } from '@aegis/shared-types';
import { EmailProviderService } from '../../src/services/email-provider.service';

/**
 * The DEV email provider (nodemailer, no SES): falls back to a no-network `jsonTransport` sink when no
 * SMTP is configured, and points a real SMTP transport at a dev mail catcher when `SMTP_HOST` is set —
 * always returning a provider reference id (the ledger contract).
 */
describe('EmailProviderService', () => {
  const message: NotificationShape.EmailMessage = {
    to: 'recipient@example.com',
    subject: 'Expense report approved',
    body: 'Your expense report R1 for 12.00 was approved.',
  };

  it('falls back to the no-network dev sink when SMTP is unconfigured and returns a ref', async () => {
    const provider = new EmailProviderService({} as NodeJS.ProcessEnv);

    const ref = await provider.send(message);

    // jsonTransport renders a real RFC822 message and yields a non-empty messageId.
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);
  });

  it('does not reach the network in dev mode (idempotent re-send still yields a ref)', async () => {
    const provider = new EmailProviderService({} as NodeJS.ProcessEnv);

    const first = await provider.send(message);
    const second = await provider.send({ ...message, to: 'other@example.com' });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
  });

  it('sends via the configured SMTP transport (dev mail catcher) when SMTP_HOST is set', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<smtp-123@aegis.local>' });
    const createTransport = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail } as never);

    try {
      const provider = new EmailProviderService({
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
      } as NodeJS.ProcessEnv);

      const ref = await provider.send(message);

      // Transport pointed at the catcher, unauthenticated (no SMTP_USER ⇒ no auth attached).
      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'localhost', port: 1025, secure: false }),
      );
      expect(createTransport.mock.calls[0][0]).not.toHaveProperty('auth');
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: message.to, subject: message.subject, text: message.body }),
      );
      expect(ref).toBe('<smtp-123@aegis.local>');
    } finally {
      createTransport.mockRestore();
    }
  });

  it('attaches SMTP auth only when credentials are supplied', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<id@x>' });
    const createTransport = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail } as never);

    try {
      // eslint-disable-next-line no-new
      new EmailProviderService({
        SMTP_HOST: 'smtp.relay.example',
        SMTP_PORT: '587',
        SMTP_USER: 'apikey',
        SMTP_PASS: 'secret',
      } as NodeJS.ProcessEnv);

      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'apikey', pass: 'secret' } }),
      );
    } finally {
      createTransport.mockRestore();
    }
  });

  it('throws when the transport fails so the sender can mark the ledger row failed', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('connection refused'));
    const createTransport = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail } as never);

    try {
      const provider = new EmailProviderService({ SMTP_HOST: 'localhost' } as NodeJS.ProcessEnv);
      await expect(provider.send(message)).rejects.toThrow('connection refused');
    } finally {
      createTransport.mockRestore();
    }
  });

  it('uses the provider-default From when the message carries none', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<id@x>' });
    const createTransport = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail } as never);

    try {
      const provider = new EmailProviderService({
        SMTP_HOST: 'localhost',
        SMTP_FROM: 'Default <no-reply@aegis.local>',
      } as NodeJS.ProcessEnv);
      await provider.send(message);

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'Default <no-reply@aegis.local>' }),
      );
    } finally {
      createTransport.mockRestore();
    }
  });

  it('wires per-tenant from/reply-to + html + attachments through to mailOptions', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<id@x>' });
    const createTransport = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail } as never);

    try {
      const provider = new EmailProviderService({ SMTP_HOST: 'localhost' } as NodeJS.ProcessEnv);
      const attachments = [
        { filename: 'report.pdf', content: Buffer.from('x'), contentType: 'application/pdf' },
      ];
      await provider.send({
        ...message,
        from: '"Acme" <billing@acme.com>',
        replyTo: 'support@acme.com',
        html: '<p>Approved</p>',
        attachments,
      });

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Acme" <billing@acme.com>',
          replyTo: 'support@acme.com',
          text: message.body,
          html: '<p>Approved</p>',
          attachments,
        }),
      );
    } finally {
      createTransport.mockRestore();
    }
  });
});
