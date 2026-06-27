import { DataTypes, type ModelAttributes, type ModelOptions } from 'sequelize';

/**
 * The column name Sequelize maintains for optimistic locking. We deliberately use `lock_version`
 * (not `version`) so it never collides with domain effective-dating columns that are also named
 * `version` (e.g. `tax_rules.version`, a >= 1 effective-date counter — NOT a lock counter).
 */
export const LOCK_VERSION_COLUMN = 'lock_version';

/** UUID primary key. */
export function idColumn(): ModelAttributes {
  return {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  };
}

/** UUID primary key + mandatory tenant_id (every tenant-scoped table gets RLS on tenant_id). */
export function tenantColumns(): ModelAttributes {
  return {
    ...idColumn(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
  };
}

/**
 * The optimistic-lock column for migrations (`createTable`). Add this to mutable AGGREGATE-ROOT
 * tables that have concurrent-update risk; pair it with `version: true` in the model options (see
 * `versionedModelOptions`). Sequelize increments it on every UPDATE and adds a
 * `WHERE lock_version = ?` guard, throwing `OptimisticLockError` on a stale write. Do NOT add this
 * to append-only / log tables.
 */
export function lockVersionColumn(): ModelAttributes {
  return {
    [LOCK_VERSION_COLUMN]: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  };
}

/** Standard model options: snake_case columns + created_at/updated_at timestamps. */
export const baseModelOptions = {
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

/**
 * Base options PLUS Sequelize optimistic locking mapped to the `lock_version` column. Spread this
 * (instead of `baseModelOptions`) on mutable aggregate roots with concurrent-update risk so stale
 * read-modify-write updates throw `OptimisticLockError`. The central model registry
 * (`model-registry.ts`) applies these consistently, which is what prevents the per-model drift that
 * produced the earlier partial-index regression.
 */
export const versionedModelOptions = {
  ...baseModelOptions,
  version: LOCK_VERSION_COLUMN,
} as const;

/**
 * Compose the shared base options for a model definition. `paranoid` adds soft-delete (`deleted_at`);
 * `version` opts the model into optimistic locking on the `lock_version` column. Centralising this
 * here (and in the registry) keeps timestamps/underscored/paranoid/version consistent across every
 * service instead of being hand-rolled per model.
 */
export function modelOptions(opts: { paranoid?: boolean; version?: boolean } = {}): ModelOptions {
  const base: ModelOptions = { ...baseModelOptions };
  if (opts.paranoid) {
    base.paranoid = true;
    base.deletedAt = 'deleted_at';
  }
  if (opts.version) {
    base.version = LOCK_VERSION_COLUMN;
  }
  return base;
}
