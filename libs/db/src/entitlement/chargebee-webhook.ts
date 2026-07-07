import { EntitlementService } from './entitlement.service';

/**
 * Chargebee webhook → `tenant_modules` entitlement mapper (the billing half of the pay-per-module
 * loop). PURE event mapping lives here — no HTTP, no Express, no Chargebee SDK. The HTTP surface
 * (basic-auth guard + always-200 semantics) is the webhook controller's job; the write path is the
 * existing {@link EntitlementService.setModuleEntitlement} idempotent upsert. NO new tables and NO
 * migrations: everything lands in the T22 `tenant_modules` table.
 */

/** One `tenant_modules` mutation derived from a Chargebee subscription event. */
export interface EntitlementChange {
  tenantId: string;
  moduleId: string;
  enabled: boolean;
  status: string;
  expiresAt: Date | null;
  plan: string | null;
}

export interface ParseChargebeeEventOptions {
  /**
   * Chargebee plan_id / addon id → aegis module ids, e.g.
   * `{ "aegis-expense-pro": ["expense"], "aegis-suite": ["expense", "invoice", "payroll"] }`.
   * Unmapped plan/addon ids are SKIPPED (never guessed) — an empty map maps nothing.
   */
  moduleMap: Record<string, string[]>;
  /**
   * Override how the aegis tenant is derived from the raw payload. The default reads
   * `content.customer.cf_tenant_id ?? content.subscription.cf_tenant_id` (Chargebee custom fields).
   * Whatever resolver runs, a non-UUID / missing result means the event is SKIPPED (returns `[]`) —
   * unmapped tenants are never guessed.
   */
  resolveTenantId?: (payload: unknown) => string | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event types that (re)grant access with no expiry (or a paid-through expiry when non_renewing). */
const ENABLE_EVENTS = new Set([
  'subscription_created',
  'subscription_activated',
  'subscription_changed',
  'subscription_resumed',
  'subscription_reactivated',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Chargebee timestamps are Unix epoch SECONDS; ISO strings are tolerated for tests/fixtures. */
function toDate(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === 'string' && v.length > 0) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Default tenant resolver: `content.customer.cf_tenant_id ?? content.subscription.cf_tenant_id`. */
function defaultResolveTenantId(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.content)) return undefined;
  const { content } = payload;
  const customer = isRecord(content.customer) ? content.customer : undefined;
  const subscription = isRecord(content.subscription) ? content.subscription : undefined;
  return asString(customer?.cf_tenant_id) ?? asString(subscription?.cf_tenant_id);
}

/**
 * Map one raw Chargebee webhook payload (the standard envelope
 * `{ id, occurred_at, event_type, content: { subscription, customer } }`) to zero or more
 * {@link EntitlementChange}s — pure, defensive, and total: any malformed / unknown / unmappable
 * input yields `[]`, never a throw.
 *
 * Event semantics:
 * - `subscription_created|activated|changed|resumed|reactivated` → enabled, status `active`,
 *   `expiresAt` null — EXCEPT a `non_renewing` subscription, which keeps `current_term_end` as the
 *   paid-through expiry.
 * - `subscription_cancelled` → STILL enabled/`active` but expiring at `current_term_end`: Chargebee
 *   fires `cancelled` at cancel time while the tenant remains paid through the term (grace). The
 *   entitlement rule (`expires_at` checked on read) turns access off at the boundary with no
 *   further event needed.
 * - `subscription_deleted` → disabled, status `cancelled`.
 * - `subscription_paused` → disabled, status `suspended`.
 * - anything else → `[]`.
 *
 * Modules come from `moduleMap[plan_id]` plus `moduleMap[addon.id]` for each addon, deduplicated;
 * ids absent from the map are skipped. A missing/non-UUID tenant skips the whole event.
 */
export function parseChargebeeEvent(
  payload: unknown,
  opts: ParseChargebeeEventOptions,
): EntitlementChange[] {
  if (!isRecord(payload)) return [];
  const eventType = asString(payload.event_type);
  if (!eventType) return [];
  if (!isRecord(payload.content)) return [];
  const subscription = isRecord(payload.content.subscription)
    ? payload.content.subscription
    : undefined;
  if (!subscription) return [];

  // Tenant: resolved (default: cf_tenant_id custom fields), then STRICTLY validated as a UUID.
  // A tenant we cannot map is skipped, never guessed — the upsert would otherwise write under an
  // attacker-chosen tenant id.
  const tenantId = (opts.resolveTenantId ?? defaultResolveTenantId)(payload);
  if (!tenantId || !UUID_RE.test(tenantId)) return [];

  // Semantics per event type.
  const termEnd = toDate(subscription.current_term_end);
  let enabled: boolean;
  let status: string;
  let expiresAt: Date | null;
  if (ENABLE_EVENTS.has(eventType)) {
    enabled = true;
    status = 'active';
    // A non_renewing subscription is active but will not renew — keep the paid-through boundary.
    expiresAt = asString(subscription.status) === 'non_renewing' ? termEnd : null;
  } else if (eventType === 'subscription_cancelled') {
    enabled = true;
    status = 'active';
    expiresAt = termEnd; // paid-through grace: access lapses at the term end, not immediately
  } else if (eventType === 'subscription_deleted') {
    enabled = false;
    status = 'cancelled';
    expiresAt = null;
  } else if (eventType === 'subscription_paused') {
    enabled = false;
    status = 'suspended';
    expiresAt = null;
  } else {
    return []; // unknown event type — not an entitlement signal
  }

  // Modules: plan + addons through the map; unmapped ids skipped; dedupe preserving order.
  const plan = asString(subscription.plan_id) ?? null;
  const billedIds: string[] = [];
  if (plan) billedIds.push(plan);
  if (Array.isArray(subscription.addons)) {
    for (const addon of subscription.addons) {
      const id = isRecord(addon) ? asString(addon.id) : undefined;
      if (id) billedIds.push(id);
    }
  }
  const moduleIds: string[] = [];
  for (const billedId of billedIds) {
    for (const moduleId of opts.moduleMap[billedId] ?? []) {
      if (!moduleIds.includes(moduleId)) moduleIds.push(moduleId);
    }
  }

  return moduleIds.map((moduleId) => ({ tenantId, moduleId, enabled, status, expiresAt, plan }));
}

/**
 * Apply parsed changes to `tenant_modules` via {@link EntitlementService.setModuleEntitlement} —
 * one RLS-scoped idempotent upsert per change, each pinned to the change's OWN tenant (webhooks run
 * off the request path, so there is no ambient RequestContext tenant). Returns the number applied.
 *
 * Delivery semantics: Chargebee delivers webhooks AT-LEAST-ONCE (it retries on any non-2xx), and
 * the upsert is keyed on (tenant_id, module_id) — replaying the same event N times converges on the
 * same single row, so duplicate delivery is safe by construction.
 *
 * OUT-OF-ORDER caveat: the upsert is last-write-wins with no version/occurred_at fencing, so a
 * delayed older event CAN overwrite the state written by a newer one (e.g. a retried
 * `subscription_created` landing after `subscription_deleted` re-enables the module until the next
 * event). Chargebee delivers near-in-order in practice; if this ever matters, fence on
 * `occurred_at` (persist it and reject older writes) — deliberately out of scope here (no new
 * tables/migrations in this track).
 */
export async function applyEntitlementChanges(changes: EntitlementChange[]): Promise<number> {
  let applied = 0;
  for (const change of changes) {
    await new EntitlementService({ tenantId: change.tenantId }).setModuleEntitlement({
      moduleId: change.moduleId,
      enabled: change.enabled,
      status: change.status,
      expiresAt: change.expiresAt,
      plan: change.plan,
    });
    applied += 1;
  }
  return applied;
}
