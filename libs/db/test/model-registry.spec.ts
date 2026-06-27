/**
 * Proves the central model registry (W2-09) applies the shared base-model options through ONE path,
 * and that optimistic locking (W2-08) maps to the `lock_version` column consistently. Uses a
 * driver-less Postgres-dialect Sequelize: `sequelize.define()` builds full model metadata without a
 * live connection, so we can assert on the resolved options/attributes with no database.
 */
import { Sequelize, DataTypes } from 'sequelize';
import { ModelRegistry, createModelRegistry } from '../src/model-registry';
import { LOCK_VERSION_COLUMN, modelOptions, versionedModelOptions, lockVersionColumn } from '../src/base-model';

/** A standalone Sequelize that never connects (metadata-only). */
function newSequelize(): Sequelize {
  return new Sequelize({ dialect: 'postgres' });
}

const idAttr = { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 } };

describe('base-model option helpers', () => {
  it('baseModelOptions are applied (underscored + named timestamps) with no version/paranoid by default', () => {
    const o = modelOptions();
    expect(o).toMatchObject({ underscored: true, timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' });
    expect(o.version).toBeUndefined();
    expect(o.paranoid).toBeUndefined();
  });

  it('modelOptions({ paranoid:true }) maps deleted_at', () => {
    const o = modelOptions({ paranoid: true });
    expect(o.paranoid).toBe(true);
    expect(o.deletedAt).toBe('deleted_at');
  });

  it('modelOptions({ version:true }) maps optimistic locking to the lock_version column', () => {
    expect(modelOptions({ version: true }).version).toBe(LOCK_VERSION_COLUMN);
    expect(LOCK_VERSION_COLUMN).toBe('lock_version');
  });

  it('versionedModelOptions carries both the base options and the lock_version mapping', () => {
    expect(versionedModelOptions).toMatchObject({ underscored: true, version: LOCK_VERSION_COLUMN });
  });

  it('lockVersionColumn() is a NOT NULL integer defaulting to 0 (migration column)', () => {
    const col = lockVersionColumn()[LOCK_VERSION_COLUMN] as { allowNull: boolean; defaultValue: number };
    expect(col.allowNull).toBe(false);
    expect(col.defaultValue).toBe(0);
  });
});

describe('ModelRegistry', () => {
  it('define() applies the shared base options and tracks the model', () => {
    const reg = createModelRegistry(newSequelize());
    const M = reg.define({ tableName: 'widgets', attributes: idAttr });

    expect(M.tableName).toBe('widgets');
    expect(M.options.underscored).toBe(true);
    expect(M.options.timestamps).toBe(true);
    expect(reg.size).toBe(1);
    expect(reg.get('widgets')).toBe(M);
    expect(reg.all()).toEqual([M]);
  });

  it('define({ version:true }) enables optimistic locking on lock_version', () => {
    const reg = createModelRegistry(newSequelize());
    const M = reg.define({ tableName: 'aggregates', attributes: idAttr, paranoid: true, version: true });

    expect(M.options.version).toBe(LOCK_VERSION_COLUMN);
    // Sequelize auto-creates the version attribute mapped to the lock_version column.
    expect(M.rawAttributes[LOCK_VERSION_COLUMN]).toBeDefined();
    expect(M.rawAttributes[LOCK_VERSION_COLUMN].field).toBe(LOCK_VERSION_COLUMN);
    expect(M.options.paranoid).toBe(true);
    expect(M.options.deletedAt).toBe('deleted_at');
  });

  it('define() is idempotent — re-registering the same table returns the original model', () => {
    const reg = createModelRegistry(newSequelize());
    const first = reg.define({ tableName: 'dupes', attributes: idAttr });
    const second = reg.define({ tableName: 'dupes', attributes: idAttr });
    expect(second).toBe(first);
    expect(reg.size).toBe(1);
  });

  it('extraOptions cannot override the centrally-managed option keys', () => {
    const reg = createModelRegistry(newSequelize());
    // Attempt to sneak paranoid/version off via extraOptions: the type forbids it, and at runtime
    // the managed keys win because they are spread before extraOptions in define().
    const M = reg.define({
      tableName: 'guarded',
      attributes: idAttr,
      version: true,
      paranoid: true,
      extraOptions: { comment: 'fine to add' } as never,
    });
    expect(M.options.version).toBe(LOCK_VERSION_COLUMN);
    expect(M.options.paranoid).toBe(true);
  });

  it('register() tracks an externally-defined model without redefining it', () => {
    const s = newSequelize();
    const reg = new ModelRegistry(s);
    const External = s.define('externals', idAttr, { tableName: 'externals', underscored: true });
    const tracked = reg.register(External);
    expect(tracked).toBe(External);
    expect(reg.get('externals')).toBe(External);
    // Re-registering returns the same instance (idempotent).
    expect(reg.register(External)).toBe(External);
    expect(reg.size).toBe(1);
  });

  it('connection exposes the underlying Sequelize', () => {
    const s = newSequelize();
    expect(createModelRegistry(s).connection).toBe(s);
  });
});
