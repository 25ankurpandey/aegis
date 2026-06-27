/** Reporting (CQRS-lite read side) enums. See docs/services/reporting.md. */

/**
 * Closed status set for an asynchronous report run (the read-side run lifecycle):
 * `queued` → `running` → `succeeded` | `failed`. Pins `report_runs.status` (default `queued`).
 */
export enum ReportRunStatus {
  Queued = 'queued',
  Running = 'running',
  Succeeded = 'succeeded',
  Failed = 'failed',
}
