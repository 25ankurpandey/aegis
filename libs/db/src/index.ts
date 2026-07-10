/**
 * @aegis/db — the data layer: a NON-OWNER Sequelize connection (so RLS is enforced),
 * tenant-scoped transactions that set the RLS context, base model helpers, RLS policy SQL,
 * and the Umzug code-first migration/seeder runners.
 */
export * from './connection';
export * from './rls';
export * from './transaction';
export * from './base-model';
export * from './model-registry';
export * from './migrator';
export * from './feature-flags-reader';
export * from './record-annotations';

// Per-tenant module entitlement core (the `tenant_modules` table): the entitlement service + repo
// + the ai-core tool-filter helpers built from it.
export * from './entitlement/types';
export * from './entitlement/tenant-modules.repository';
export * from './entitlement/entitlement.service';
export * from './entitlement/tool-filter';

// Per-tenant "app-brain" semantic-memory core (the `app_brain_memory` table): the pgvector-backed
// self-knowledge / RAG store — types (incl. APP_BRAIN_EMBEDDING_DIM), the embedding seam, the
// RLS-scoped repository, and the service that owns the embed step.
export * from './brain/types';
export * from './brain/embedding-client';
export * from './brain/app-brain.repository';
export * from './brain/app-brain.service';
export * from './brain/indexers';

// Reconciliation — the vetted, RLS-scoped deterministic recompute queries the reconciliation
// autonomous capability runs (pure data; no @aegis/ai-core dependency — adapted at the wiring site).
export * from './reconciliation/queries';

// Chargebee webhook → entitlement materialization (pure event mapper + idempotent applier).
export * from './entitlement/chargebee-webhook';

// ABAC Phase 1 (docs/strategy/abac-generalization.md §3 Q6 option (a)): the shared-DB PolicyReadPort
// implementation — a model-free, RLS-scoped raw SELECT of persisted `policies` rows — plus its
// per-service bootstrap registration (`registerDbPolicyReadPort()`). Registration is EXPLICIT (not
// import-time like the feature-flag reader): a dormant service stays dormant until its bootstrap opts in.
export * from './policy-read-port';

// Make per-tenant feature-flag lookups live: importing @aegis/db (which every DB-backed service does
// at bootstrap via its models context) registers the DB-backed reader into the service-core helper,
// so `FeatureFlags.isEnabled(...)` resolves against `tenant_features` instead of failing soft to off.
import { registerDefaultFeatureFlagReader } from './feature-flags-reader';
registerDefaultFeatureFlagReader();
