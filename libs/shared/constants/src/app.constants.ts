/**
 * @aegis/shared-constants — per-area Constants classes (the architecture-donor pattern,
 * de-branded). Static, typed, grep-able.
 */

export class ApiConstants {
  static readonly Version = 'v1';
  /** Internal (service-to-service) route prefix. */
  static readonly InternalPrefix = '/internal/v1';
  /** Authenticated end-user route prefix. */
  static readonly PublicPrefix = '/v1';
  /** Build a service's external context path, e.g. contextPath('expense') => '/expense/v1'. */
  static contextPath(domain: string): string {
    return `/${domain}/${ApiConstants.Version}`;
  }
  static internalContextPath(domain: string): string {
    return `/${domain}${ApiConstants.InternalPrefix}`;
  }
}

export class PaginationConstants {
  static readonly DefaultPageSize = 25;
  static readonly MaxPageSize = 200;
  static readonly DefaultPage = 1;
}

export class AuthConstants {
  static readonly DefaultTokenTtlSeconds = 900;
  static readonly InternalOrigin = 'aegis-internal';
  static readonly JwksPath = '/.well-known/jwks.json';
}

export class HealthConstants {
  static readonly Path = '/health';
}

/** Postgres session variables used to drive Row-Level Security. */
export class RlsConstants {
  static readonly TenantVar = 'app.current_tenant';
  static readonly UserVar = 'app.current_user';
  /**
   * Outbox-relay bypass marker. The relay drains pending outbox rows across ALL tenants, so it cannot
   * pin a single `app.current_tenant`. The `event_outbox` RESTRICTIVE policy admits a row when its
   * tenant matches `app.current_tenant` OR this marker is set to `'on'`. ONLY the relay sets it (via
   * `SET LOCAL`, transaction-local), so normal tenant-scoped sessions never gain cross-tenant visibility.
   */
  static readonly OutboxRelayVar = 'app.outbox_relay';
}
