/**
 * Single source of truth for every HTTP header name Aegis reads or writes.
 * Referenced by the context middleware, the HTTP client, and the service-to-service layer
 * so a rename is one line. See docs/06-service-to-service.md.
 */
export enum HttpHeaderKey {
  Authorization = 'authorization',
  /** Tenant (organization) the request operates within. */
  TenantId = 'x-tenant-id',
  /**
   * THE single request-tracking id. Minted at the gateway, REQUIRED on every internal hop,
   * validated by the context middleware, propagated unchanged across every service call + async
   * message, and stamped on every log line. We deliberately do NOT also carry an X-Trace-Id —
   * it would be redundant. If distributed tracing is added later, the OpenTelemetry SDK carries
   * trace context via the standard W3C `traceparent` header (managed by the SDK, not by us).
   */
  CorrelationId = 'x-correlation-id',
  /** The immediate caller service/app name. */
  Caller = 'x-caller',
  /** The originating service for audit attribution (typed by SourceService). */
  SourceService = 'x-source-service',
  /** Gate for internal service-to-service calls; value must equal INTERNAL_ORIGIN. */
  InternalOrigin = 'x-internal-origin',
  /** Signed internal service token (verifies the calling service for internal-only routes). */
  InternalToken = 'x-internal-token',
  /** Idempotency key required on money/state-changing writes. */
  IdempotencyKey = 'idempotency-key',
}

/** Headers that MUST be present (and valid) on an authenticated external request — fail-closed if missing. */
export const REQUIRED_REQUEST_HEADERS: readonly HttpHeaderKey[] = [
  HttpHeaderKey.TenantId,
  HttpHeaderKey.CorrelationId,
];

/** Headers that MUST be present on an internal (service-to-service) request. */
export const REQUIRED_INTERNAL_HEADERS: readonly HttpHeaderKey[] = [
  HttpHeaderKey.InternalOrigin,
  HttpHeaderKey.SourceService,
  HttpHeaderKey.TenantId,
  HttpHeaderKey.CorrelationId,
];
