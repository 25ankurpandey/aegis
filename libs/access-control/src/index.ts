/**
 * @aegis/access-control — Casbin-backed RBAC (with tenant domains: `dom` = tenantId), plus the
 * ABAC + row-level-scope layers and the Policy Enforcement Point middleware.
 *
 *  - enforcer.ts          Casbin model + factory (pg-adapter for prod, in-memory for tests)
 *  - pep.ts               authenticate() + authorize() — per-route guards (Casbin RBAC gate)
 *  - scope.ts             checkRowScope() — row-level visibility, a separate layer from Casbin
 *  - pdp.ts               decide() — ABAC + tenant-isolation + scope evaluator (Casbin complement)
 *  - condition-evaluator  ABAC condition operators
 *  - watcher.ts           Redis pub/sub policy-reload bus (PAP mutations reach running pods, W5-03)
 *  - policy-loader.ts     load applicable ABAC policies from the PAP/DB for authorize() (W5-04)
 * See docs/03-access-control-model.md.
 */
export * from './enforcer';
export * from './scope';
export * from './condition-evaluator';
export * from './pdp';
export * from './pep';
export * from './watcher';
export * from './policy-loader';
