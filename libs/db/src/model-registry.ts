import type { ModelStatic, Model, Sequelize, ModelAttributes, ModelOptions } from 'sequelize';
import { baseModelOptions, modelOptions } from './base-model';

/**
 * Per-model registration spec. Every aggregate / table opts into the shared base-model options
 * through ONE path (this registry) instead of hand-rolling `underscored`/`timestamps`/`paranoid`/
 * `version` per file. The absence of a single path is what let the partial-unique-index and
 * optimistic-locking regressions slip in on some tables but not others — the registry makes the
 * shared options uniform by construction.
 */
export interface ModelSpec {
  /** Physical table name (also used as the Sequelize model name, matching the existing convention). */
  tableName: string;
  /** Column attributes for `sequelize.define`. */
  attributes: ModelAttributes;
  /** Soft-delete (paranoid → `deleted_at`). Defaults to false. */
  paranoid?: boolean;
  /** Optimistic locking on the shared `lock_version` column. Defaults to false. */
  version?: boolean;
  /**
   * Escape hatch for the rare model that needs an extra Sequelize option the shared set does not
   * cover (e.g. a custom `defaultScope`). Merged LAST but can NOT override the managed keys
   * (timestamps/underscored/paranoid/version/tableName) — those stay centrally owned.
   */
  extraOptions?: Omit<ModelOptions, 'tableName' | 'paranoid' | 'deletedAt' | 'version' | keyof typeof baseModelOptions>;
}

/**
 * A registry bound to one Sequelize connection. Each service's `database-context.ts` creates one,
 * calls `define(...)` for every model (which applies the shared base options consistently), and
 * reads them back to assemble its typed context. `defineRaw` is the escape hatch for join / config
 * tables that legitimately diverge from the standard option set.
 */
export class ModelRegistry {
  private readonly models = new Map<string, ModelStatic<Model>>();

  constructor(private readonly sequelize: Sequelize) {}

  /** The underlying connection (so contexts can still expose `sequelize` in their return shape). */
  get connection(): Sequelize {
    return this.sequelize;
  }

  /**
   * Define a model with the shared base-model options applied centrally. Registering the same table
   * name twice returns the already-registered model (idempotent — contexts are memoized singletons).
   */
  define(spec: ModelSpec): ModelStatic<Model> {
    const existing = this.models.get(spec.tableName);
    if (existing) return existing;

    const options: ModelOptions = {
      tableName: spec.tableName,
      ...modelOptions({ paranoid: spec.paranoid, version: spec.version }),
      ...(spec.extraOptions ?? {}),
    };
    const model = this.sequelize.define(spec.tableName, spec.attributes, options);
    this.models.set(spec.tableName, model);
    return model;
  }

  /**
   * Register a model defined elsewhere (e.g. a `define<Entity>(sequelize)` factory) so it is tracked
   * by the registry without re-defining it. Keeps backward compatibility with the per-file model
   * factories while still routing every model through one registration path.
   */
  register(model: ModelStatic<Model>): ModelStatic<Model> {
    const name = model.tableName;
    const existing = this.models.get(name);
    if (existing) return existing;
    this.models.set(name, model);
    return model;
  }

  /** All registered models (registration order is insertion order). */
  all(): ModelStatic<Model>[] {
    return [...this.models.values()];
  }

  /** Look up a registered model by table name, if any. */
  get(tableName: string): ModelStatic<Model> | undefined {
    return this.models.get(tableName);
  }

  /** Number of registered models. */
  get size(): number {
    return this.models.size;
  }
}

/** Convenience factory mirroring the rest of `@aegis/db`'s `getX()` style. */
export function createModelRegistry(sequelize: Sequelize): ModelRegistry {
  return new ModelRegistry(sequelize);
}
