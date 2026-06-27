/**
 * Typed connector error hierarchy — mirrors the donor's `RetryException` vs
 * `UnrecoverableException` distinction (see docs/analysis/ERP_proxy_alignment.md §4 item 4). The
 * generic bus retry/DLQ is coarse: it retries EVERY thrown error the same way, so a permanently-bad
 * payload ("ERP period closed", malformed entity) burns the full retry budget before dead-lettering.
 *
 * `BaseConnector.withRetry` consults these markers so it:
 *   - retries a {@link RetryableError} (and anything untyped — fail-OPEN to retry, the safe default for
 *     transient ERP outages) with exponential backoff, and
 *   - fast-fails an {@link UnrecoverableError} WITHOUT consuming further attempts, parking the push as a
 *     durable `status=error` sync-state row an operator can inspect / re-drive.
 */

/** Base class for connector-domain errors so callers can `instanceof ConnectorError`. */
export abstract class ConnectorError extends Error {
  abstract readonly retryable: boolean;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain across the TS→ES5 transpile so `instanceof` holds.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A transient failure that SHOULD be retried (ERP 5xx / timeout / rate-limit / token expiry). Equivalent
 * to the donor's `RetryException`/`AuthorizationException` — both drive the retry loop.
 */
export class RetryableError extends ConnectorError {
  readonly retryable = true;
}

/**
 * A permanent failure that must NOT be retried (bad payload, validation reject, "period closed"). The
 * retry loop rethrows it immediately so the push is parked as `error` without exhausting the budget —
 * the donor's `UnrecoverableException` semantics.
 */
export class UnrecoverableError extends ConnectorError {
  readonly retryable = false;
}

/**
 * Whether an unknown error should be retried. A typed {@link ConnectorError} answers for itself; any
 * other (untyped) error is treated as retryable — fail-OPEN, because most untyped throws from an ERP
 * client are transient (network), and a truly permanent one still terminates at the retry budget and
 * lands as `error`. Only an explicit {@link UnrecoverableError} short-circuits the budget.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ConnectorError) return err.retryable;
  return true;
}
