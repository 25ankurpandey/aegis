import { EmailNotificationStatus } from '@aegis/shared-enums';

/**
 * Send-gating policy (G3) — the env-driven recipient-domain allow/deny lists and the non-prod
 * subject prefix, evaluated in `EmailSenderService` BEFORE `provider.send`. Pure + dependency-free
 * so it is exhaustively unit-testable; the tenant master-switch (DB) and the suppression list (DB)
 * are checked separately by the sender. Follows an established domain allow/deny list + `[STAGING]`
 * subject-prefixing pattern, implemented here with no external names and no credentials.
 *
 * Env surface (all optional):
 *  - `EMAIL_ALLOW_DOMAINS`  — comma list; if set, ONLY these recipient domains may be mailed.
 *  - `EMAIL_DENY_DOMAINS`   — comma list; these recipient domains are always blocked (wins over allow).
 *  - `EMAIL_SUBJECT_PREFIX` — literal prefix prepended to every subject (e.g. `[STAGING]`).
 *  - `EMAIL_ENV` / `NODE_ENV` — when not `production`, a `[NODE_ENV]` prefix is auto-applied if no
 *    explicit `EMAIL_SUBJECT_PREFIX` is set (so non-prod mail is always visibly tagged).
 */

/** Outcome of the env gate: either allowed (with the possibly-prefixed subject) or blocked. */
export type GateDecision =
  | { allowed: true; subject: string }
  | { allowed: false; status: EmailNotificationStatus.Blocked; reason: string };

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/** Extract the lower-cased domain part of an address (after the last `@`); '' when malformed. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).trim().toLowerCase();
}

export class EmailGatingPolicy {
  private readonly allow: string[];
  private readonly deny: string[];
  private readonly subjectPrefix: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.allow = parseList(env.EMAIL_ALLOW_DOMAINS);
    this.deny = parseList(env.EMAIL_DENY_DOMAINS);

    const explicit = env.EMAIL_SUBJECT_PREFIX?.trim();
    if (explicit) {
      this.subjectPrefix = explicit;
    } else {
      // Auto-tag non-prod mail so a leaked staging send is unmistakable.
      const envName = (env.EMAIL_ENV ?? env.NODE_ENV ?? '').trim().toLowerCase();
      this.subjectPrefix = envName && envName !== 'production' ? `[${envName.toUpperCase()}]` : '';
    }
  }

  /** Apply the configured subject prefix (idempotent — never double-prefixes). */
  applySubjectPrefix(subject: string): string {
    if (!this.subjectPrefix) return subject;
    if (subject.startsWith(this.subjectPrefix)) return subject;
    return `${this.subjectPrefix} ${subject}`;
  }

  /**
   * Evaluate the recipient-domain allow/deny lists + subject prefix for one address.
   * Deny wins over allow. An allow-list, when configured, is a strict whitelist.
   */
  evaluate(address: string, subject: string): GateDecision {
    const domain = domainOf(address);

    if (this.deny.length > 0 && this.deny.includes(domain)) {
      return {
        allowed: false,
        status: EmailNotificationStatus.Blocked,
        reason: `blocked: recipient domain '${domain}' is deny-listed`,
      };
    }
    if (this.allow.length > 0 && !this.allow.includes(domain)) {
      return {
        allowed: false,
        status: EmailNotificationStatus.Blocked,
        reason: `blocked: recipient domain '${domain}' not on the allow-list`,
      };
    }
    return { allowed: true, subject: this.applySubjectPrefix(subject) };
  }
}
