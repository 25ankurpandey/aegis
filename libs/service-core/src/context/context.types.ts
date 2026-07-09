import type { SourceService } from '@aegis/shared-enums';

/**
 * Ambient per-request state. Exactly the SPEC §6 field set — no entry-context,
 * no donor request-id header. Stored in AsyncLocalStorage by RequestContext.
 */
export interface RequestContextData {
  /** Required on tenant-scoped requests; used to set app.current_tenant for RLS. */
  tenantId: string;
  /** Set by the PEP after authentication. */
  userId?: string;
  /** Set by the PEP after authentication. */
  roles?: string[];
  /** Row-level scope claim (own_only | own_and_team | all), set by the PEP — drives list-route
   *  scope filters in services that have no single resource for checkRowScope to gate. */
  scope?: string;
  /** The principal's team ids (PIP attribute), set by the PEP — used by own_and_team list filters. */
  teamIds?: string[];
  /** X-Correlation-Id — the single request-tracking id, propagated unchanged across hops. */
  correlationId: string;
  /** X-Caller — logical origin (client app / user agent). */
  caller?: string;
  /** X-Source-Service — set on service-to-service hops. */
  sourceService?: SourceService;
  /** Raw bearer/internal token for downstream propagation. */
  token?: string;
  requestUrl?: string;
  ipAddress?: string;
  /** epoch ms when the context opened (for latency). */
  startedAt: number;
}
