import { randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { unmanaged } from 'inversify';
import { Logger } from '@aegis/service-core';
import type { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';

/**
 * Email provider — a real, dependency-light DEV provider built on `nodemailer`, behind the unchanged
 * `EmailProvider` port so a production binding stays swappable. (Rationale + donor comparison live in
 * docs/analysis/EMAIL_alignment.md.)
 *
 * Two transports, chosen at construction from env (no network unless explicitly configured):
 *
 *  - SMTP mode (`SMTP_HOST` set): a `nodemailer` SMTP transport pointed at a dev mail catcher
 *    (MailHog/Mailpit/Mailtrap) or a relay. Auth is attached ONLY when `SMTP_USER`/`SMTP_PASS` are
 *    present, so an unauthenticated local catcher (host=localhost, port=1025) works out of the box.
 *
 *  - DEV mode (default, no `SMTP_HOST`): nodemailer's built-in `jsonTransport` — a no-network sink
 *    that fully renders the RFC822 message and returns a real `messageId`, then logs it. This makes
 *    the channel observable end-to-end in tests/local without holding credentials or reaching the
 *    network (a leaked notification DB row still cannot send mail).
 *
 * Either way the port contract is preserved: `send()` returns a provider reference id and THROWS on
 * a transport failure, so the idempotent sender records `failed` + lets the bus retry/dead-letter.
 */

/** Resolved transport config + the human label used in logs and the `messageId` fallback prefix. */
interface ResolvedTransport {
  mode: 'smtp' | 'dev';
  options: nodemailer.TransportOptions;
}

function resolveTransport(env: NodeJS.ProcessEnv): ResolvedTransport {
  const host = env.SMTP_HOST?.trim();
  if (host) {
    const port = Number.parseInt(env.SMTP_PORT ?? '1025', 10);
    const user = env.SMTP_USER?.trim();
    const pass = env.SMTP_PASS;
    const options: Record<string, unknown> = {
      host,
      port: Number.isFinite(port) ? port : 1025,
      // `secure` true ⇒ TLS on connect (465); otherwise STARTTLS-upgradeable plain (587/1025).
      secure: env.SMTP_SECURE === 'true',
    };
    // Attach auth ONLY when supplied — local catchers (MailHog/Mailpit) accept unauthenticated mail.
    if (user) options.auth = { user, pass: pass ?? '' };
    return { mode: 'smtp', options: options as nodemailer.TransportOptions };
  }
  // No SMTP configured ⇒ safe no-network dev sink that still produces a real RFC822 message.
  return { mode: 'dev', options: { jsonTransport: true } as nodemailer.TransportOptions };
}

@provideSingleton(EmailProviderService)
export class EmailProviderService implements NotificationShape.EmailProvider {
  private readonly mode: 'smtp' | 'dev';
  private readonly from: string;
  private readonly transporter: Transporter;

  constructor(@unmanaged() env: NodeJS.ProcessEnv = process.env) {
    const resolved = resolveTransport(env);
    this.mode = resolved.mode;
    this.transporter = nodemailer.createTransport(resolved.options);
    this.from =
      env.SMTP_FROM?.trim() ||
      `"${env.APP_NAME?.trim() || 'Aegis'}" <${env.SMTP_USER?.trim() || 'no-reply@aegis.local'}>`;

    Logger.info('email provider initialized', { mode: this.mode });
  }

  async send(message: NotificationShape.EmailMessage): Promise<string> {
    const info = await this.transporter.sendMail({
      // Per-tenant From overrides the provider default when the sender resolved one.
      from: message.from ?? this.from,
      to: message.to,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject,
      text: message.body,
      // Rich parts the nodemailer transport already supports (mailOptions html + attachments).
      ...(message.html ? { html: message.html } : {}),
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
    });

    // nodemailer always returns a messageId; keep a `mail_<uuid>` fallback so the ledger ref is never
    // empty even if a future custom transport omits it (preserves the existing provider-ref contract).
    const ref = info.messageId || `mail_${randomUUID()}`;
    Logger.info('email dispatched', {
      mode: this.mode,
      to: message.to,
      subject: message.subject,
      providerRef: ref,
    });
    return ref;
  }
}
