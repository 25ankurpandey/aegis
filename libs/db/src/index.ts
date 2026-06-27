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

// Make per-tenant feature-flag lookups live: importing @aegis/db (which every DB-backed service does
// at bootstrap via its models context) registers the DB-backed reader into the service-core helper,
// so `FeatureFlags.isEnabled(...)` resolves against `tenant_features` instead of failing soft to off.
import { registerDefaultFeatureFlagReader } from './feature-flags-reader';
registerDefaultFeatureFlagReader();
