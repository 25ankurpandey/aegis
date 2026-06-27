import { EmailNotificationStatus } from '@aegis/shared-enums';
import { EmailGatingPolicy, domainOf } from '../../src/services/email-gating';

/**
 * G3 — env-driven send-gating: recipient-domain allow/deny lists + non-prod subject prefix. Pure
 * policy, so every branch is unit-testable without a DB or transport.
 */
describe('EmailGatingPolicy', () => {
  it('allows any domain and does not prefix when nothing is configured', () => {
    const gate = new EmailGatingPolicy({} as NodeJS.ProcessEnv);
    const d = gate.evaluate('user@acme.com', 'Hello');
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.subject).toBe('Hello');
  });

  it('blocks a deny-listed recipient domain', () => {
    const gate = new EmailGatingPolicy({ EMAIL_DENY_DOMAINS: 'evil.com, spam.io' } as NodeJS.ProcessEnv);
    const d = gate.evaluate('user@evil.com', 'Hello');
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.status).toBe(EmailNotificationStatus.Blocked);
      expect(d.reason).toMatch(/deny-listed/);
    }
  });

  it('blocks any domain not on a configured allow-list (strict whitelist)', () => {
    const gate = new EmailGatingPolicy({ EMAIL_ALLOW_DOMAINS: 'acme.com' } as NodeJS.ProcessEnv);
    expect(gate.evaluate('user@other.com', 'Hi').allowed).toBe(false);
    expect(gate.evaluate('user@acme.com', 'Hi').allowed).toBe(true);
  });

  it('lets deny win over allow when a domain is on both lists', () => {
    const gate = new EmailGatingPolicy({
      EMAIL_ALLOW_DOMAINS: 'acme.com',
      EMAIL_DENY_DOMAINS: 'acme.com',
    } as NodeJS.ProcessEnv);
    expect(gate.evaluate('user@acme.com', 'Hi').allowed).toBe(false);
  });

  it('applies an explicit subject prefix idempotently', () => {
    const gate = new EmailGatingPolicy({ EMAIL_SUBJECT_PREFIX: '[STAGING]' } as NodeJS.ProcessEnv);
    const d = gate.evaluate('user@acme.com', 'Invoice approved');
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.subject).toBe('[STAGING] Invoice approved');
    // Idempotent — never double-prefixes.
    expect(gate.applySubjectPrefix('[STAGING] Invoice approved')).toBe('[STAGING] Invoice approved');
  });

  it('auto-tags non-production mail from EMAIL_ENV/NODE_ENV when no explicit prefix is set', () => {
    const gate = new EmailGatingPolicy({ NODE_ENV: 'staging' } as NodeJS.ProcessEnv);
    const d = gate.evaluate('user@acme.com', 'Hi');
    if (d.allowed) expect(d.subject).toBe('[STAGING] Hi');
  });

  it('does not auto-tag in production', () => {
    const gate = new EmailGatingPolicy({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    const d = gate.evaluate('user@acme.com', 'Hi');
    if (d.allowed) expect(d.subject).toBe('Hi');
  });

  it('domainOf extracts the lower-cased domain part', () => {
    expect(domainOf('User@Acme.COM')).toBe('acme.com');
    expect(domainOf('not-an-email')).toBe('');
  });
});
