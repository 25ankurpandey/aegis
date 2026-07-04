import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';
import { APP_BRAIN_EMBEDDING_DIM, rlsPolicyStatements } from '@aegis/db';

// Physical table name. `app_brain_memory` is not in the TableName enum (shared-enums is owned
// elsewhere), so it is referenced as a literal here and in the repository.
const APP_BRAIN = 'app_brain_memory';

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};
const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
};
const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};

/**
 * app_brain_memory: the per-tenant "app-brain" semantic-memory store — the self-knowledge / RAG
 * substrate. One row per embedded memory (a doc chunk, a tool description, an audit finding, a
 * note, ...) with a pgvector `embedding` column for cosine-similarity recall. Tenant-scoped
 * (tenant_id NOT NULL) with FORCE + RESTRICTIVE RLS exactly like every other tenant table.
 *
 * The `embedding` column dimension is APP_BRAIN_EMBEDDING_DIM (the single source of truth shared
 * with the default HashingEmbeddingClient). Swapping in a provider with a different dimension is a
 * new migration.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // (a) Ensure the pgvector extension exists. Idempotent; documents the dependency for fresh DBs.
  await q.sequelize.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  // (b) Scalar columns only — the vector column is added via raw SQL below (Sequelize has no
  //     DataType for pgvector's `vector`).
  await q.createTable(APP_BRAIN, {
    id: uuidPk,
    tenant_id: tenantFk,
    kind: { type: DataTypes.TEXT, allowNull: false },
    ref: { type: DataTypes.TEXT, allowNull: true },
    title: { type: DataTypes.TEXT, allowNull: true },
    content: { type: DataTypes.TEXT, allowNull: false },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...timestamps,
  });

  // (c) The pgvector embedding column, dimensioned by the single-source-of-truth constant.
  await q.sequelize.query(
    `ALTER TABLE "${APP_BRAIN}" ADD COLUMN "embedding" vector(${APP_BRAIN_EMBEDDING_DIM});`,
  );

  // (d) Partial unique index: at most one memory per (tenant, kind, ref) when ref is present. This
  //     backs the repository's ON CONFLICT (tenant_id, kind, ref) WHERE ref IS NOT NULL upsert.
  await q.sequelize.query(
    `CREATE UNIQUE INDEX "app_brain_memory_tenant_kind_ref_uq"
       ON "${APP_BRAIN}" (tenant_id, kind, ref) WHERE ref IS NOT NULL;`,
  );

  // (e) Btree for the common "this tenant's memories of a kind" filter.
  await q.sequelize.query(
    `CREATE INDEX "app_brain_memory_tenant_kind_idx" ON "${APP_BRAIN}" (tenant_id, kind);`,
  );

  // (f) HNSW index for approximate nearest-neighbour cosine search (matches the `<=>` operator used
  //     by AppBrainRepository.searchSimilar).
  await q.sequelize.query(
    `CREATE INDEX "app_brain_memory_embedding_hnsw"
       ON "${APP_BRAIN}" USING hnsw (embedding vector_cosine_ops);`,
  );

  // (g) Row-Level Security (tenant_id keyed, FORCE + RESTRICTIVE) — mirrors the other tenant tables.
  const stmts = rlsPolicyStatements(APP_BRAIN);
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }

  // (h) The non-owner runtime role reaches tables through ALTER DEFAULT PRIVILEGES set at DB init,
  //     but grant explicitly too so this table's app access is self-documented and robust to a DB
  //     provisioned without those default privileges.
  await q.sequelize.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${APP_BRAIN}" TO aegis_app;`);
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // Leave the `vector` extension in place (other tables may use it).
  await q.dropTable(APP_BRAIN);
}
