/**
 * @aegis/approvals — the shared multi-level approval engine. ONE configurable, tenant-scoped,
 * hierarchy-aware engine routes approvals for every record type (expense reports, invoices, pay
 * runs, …) keyed by a polymorphic `(record_type, record_id)`, replacing the three independent
 * single-shot inline approvals. Multi-level sequential chains, parallel quorum, reject
 * short-circuit, no-double-vote, SoD requester-exclusion, and transactional-outbox eventing.
 * See docs/analysis/B1-approvals.md and SPEC §11.
 */
export * from './ioc/container';
export * from './models/database-context';
export * from './repositories/policy.repository';
export * from './repositories/hierarchy.repository';
export * from './repositories/approver-group.repository';
export * from './repositories/record-approver.repository';
export * from './repositories/vote.repository';
export * from './repositories/lock.repository';
export * from './resolver';
export * from './approval.service';

/**
 * THE REUSABLE ONE-LINER for a consuming finance service (expense / invoice / payroll) to make the
 * shared `ApprovalService` (+ its repositories) injectable into the SERVICE's OWN container.
 *
 * How it works: `inversify-binding-decorators` keeps ONE process-global registry of every
 * `@provideSingleton`-decorated class (keyed on `Reflect`). A service's `loadProviders()` already
 * does `container.load(buildProviderModule())`, which binds EVERY decorated class imported so far.
 * The only requirement for a consumer is that the approval classes are imported (their decorators
 * evaluated) BEFORE that single `container.load(...)` runs — then the engine + repos fall into the
 * service container alongside the service's own providers. This module statically imports the engine
 * and every repository above, so importing `@aegis/approvals` evaluates those decorators; calling
 * this function from a consumer's loader is the explicit, self-documenting form of that guarantee.
 *
 * Usage (copy verbatim into a service's `src/ioc/loader.ts`, BEFORE `container.load(...)`):
 *
 * ```ts
 * import { registerApprovalProviders } from '@aegis/approvals';
 * registerApprovalProviders();           // evaluate the engine's @provideSingleton decorators
 * container.load(buildProviderModule());  // ONE load binds service providers + the approval engine
 * ```
 *
 * The engine reads the ambient tenant from RequestContext and opens its own `withTenantTransaction`,
 * so nothing else needs wiring — the service just `@inject(ApprovalService)` and calls it.
 *
 * IMPORTANT: do NOT `container.load(buildProviderModule())` a SECOND time for approvals — the single
 * load in `loadProviders()` already binds the engine (the registry is global). A second load would
 * re-bind every decorated class and Inversify would throw on the duplicate.
 */
export function registerApprovalProviders(): void {
  // No-op marker: the work is the static imports above (evaluated when this module loads), which
  // register the engine + repository `@provideSingleton` decorators into the global registry.
  approvalProvidersRegistered = true;
}

let approvalProvidersRegistered = false;
/** Whether {@link registerApprovalProviders} has run (test / diagnostic seam). */
export function areApprovalProvidersRegistered(): boolean {
  return approvalProvidersRegistered;
}
