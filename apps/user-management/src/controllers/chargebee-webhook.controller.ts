import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { controller, httpPost } from 'inversify-express-utils';
import { Config, ErrUtils, Logger, markAuthGuard } from '@aegis/service-core';
// TODO(wiring): switch to `from '@aegis/db'` once the chargebee-webhook barrel export lands in
// libs/db/src/index.ts (owned by another pass) — the relative import is equivalent until then.
import {
  applyEntitlementChanges,
  parseChargebeeEvent,
} from '../../../../libs/db/src/entitlement/chargebee-webhook';

/**
 * Compare two secrets without leaking their length or a mismatch position through timing. Hashing
 * both sides first gives constant-length buffers so `timingSafeEqual` is always applicable.
 */
function timingSafeEq(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * HTTP Basic-auth guard for the Chargebee webhook, credentials from
 * `AEGIS_CHARGEBEE_WEBHOOK_USER` / `AEGIS_CHARGEBEE_WEBHOOK_PASSWORD`. FAIL-CLOSED: 401 when the
 * env vars are unset, the header is absent/malformed, or either credential mismatches
 * (timing-safe comparison). `markAuthGuard`-tagged so the boot-time fail-closed PEP assertion
 * (`assertPepBeforeRoutes`) recognises the route as guarded — the same pattern as `internalAuth()`.
 */
function chargebeeBasicAuth(): RequestHandler {
  return markAuthGuard((req, _res, next) => {
    const expectedUser = Config.get('AEGIS_CHARGEBEE_WEBHOOK_USER');
    const expectedPassword = Config.get('AEGIS_CHARGEBEE_WEBHOOK_PASSWORD');
    if (!expectedUser || !expectedPassword) {
      // Unconfigured => nobody gets in (fail closed), never "unconfigured => open".
      return next(ErrUtils.unauthorized('Chargebee webhook credentials are not configured'));
    }
    const match = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!match) {
      return next(ErrUtils.unauthorized('Missing Basic authorization'));
    }
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) {
      return next(ErrUtils.unauthorized('Malformed Basic authorization'));
    }
    const userOk = timingSafeEq(decoded.slice(0, sep), expectedUser);
    const passwordOk = timingSafeEq(decoded.slice(sep + 1), expectedPassword);
    if (!userOk || !passwordOk) {
      return next(ErrUtils.unauthorized('Invalid webhook credentials'));
    }
    return next();
  });
}

/**
 * Chargebee plan/addon id → aegis module ids, from `AEGIS_CHARGEBEE_MODULE_MAP` (JSON, e.g.
 * `{"aegis-expense-pro":["expense"],"aegis-suite":["expense","invoice","payroll"]}`). Defaults to
 * `{}` — with an empty map every event is parsed but maps to nothing, so nothing is applied.
 * Malformed JSON is logged and treated as `{}` (skip-everything is the safe failure mode; a config
 * error must not turn into a Chargebee retry storm).
 */
function moduleMapFromEnv(): Record<string, string[]> {
  const raw = Config.get('AEGIS_CHARGEBEE_MODULE_MAP');
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string[]>;
    }
  } catch {
    /* fall through to the warn below */
  }
  Logger.warn('AEGIS_CHARGEBEE_MODULE_MAP is not a JSON object — treating as {} (all plans skipped)');
  return {};
}

/**
 * Chargebee → entitlement webhook: billing events land here and are upserted into `tenant_modules`
 * (the pay-per-module loop's ingestion half).
 *
 * UNAUTHENTICATED BY DESIGN apart from HTTP Basic auth: Chargebee cannot mint an Aegis JWT, so this
 * route deliberately does NOT use `authenticate()`/`authorize()`. Two consequences, both intended:
 * - The Basic guard above is `markAuthGuard`-tagged, so the boot-time PEP assertion still sees the
 *   route as guarded (fail-closed posture preserved).
 * - It carries NO `markPermissions` stamp, so `generateToolRegistry` (which only emits tools for
 *   permission-stamped routes) can never surface it as an agent tool — the webhook stays out of the
 *   auto tool registry by construction.
 *
 * Response contract: ALWAYS `200 { received, applied }` once Basic auth passes. Chargebee retries
 * on any non-2xx, and a mapping miss (unknown plan id, missing/foreign tenant) is a configuration
 * state — not a delivery failure — so it must not trigger retries; `applied` simply reports how
 * many changes landed. A genuine failure (e.g. DB down) still throws → 5xx → Chargebee retries,
 * which is safe because `applyEntitlementChanges` is an idempotent upsert (at-least-once delivery
 * converges; see its doc-comment for the out-of-order caveat).
 *
 * NOTE (wiring): the shared context middleware fail-closed requires X-Tenant-Id/X-Correlation-Id
 * headers, which Chargebee does not send — `/webhooks/chargebee` must be added to the context
 * middleware `excludePaths` in this service's bootstrap. The handler needs no ambient context: the
 * tenant comes from the payload and every upsert pins its own tenant explicitly.
 */
@controller('/webhooks')
export class ChargebeeWebhookController {
  @httpPost('/chargebee', chargebeeBasicAuth())
  async receive(req: Request, res: Response): Promise<void> {
    const changes = parseChargebeeEvent(req.body, { moduleMap: moduleMapFromEnv() });
    const applied = await applyEntitlementChanges(changes);
    res.status(200).json({ received: true, applied });
  }
}
