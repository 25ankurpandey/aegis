import { Umzug, SequelizeStorage, type MigrationParams } from 'umzug';
import type { QueryInterface, Sequelize } from 'sequelize';
import { getSequelize } from './connection';

export type Migration = Umzug<QueryInterface>['_types']['migration'];

/** An explicitly-imported migration (works with bundled apps where glob-on-disk is unavailable). */
export interface MigrationModule {
  name: string;
  up: (params: MigrationParams<QueryInterface>) => Promise<void>;
  down: (params: MigrationParams<QueryInterface>) => Promise<void>;
}

/** Build a migrator from an explicit, ordered list of migrations (the bundled-app path). */
export function createMigratorFromList(
  migrations: MigrationModule[],
  sequelize: Sequelize = getSequelize(),
): Umzug<QueryInterface> {
  return new Umzug({
    migrations,
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, modelName: 'migrations_meta' }),
    logger: console,
  });
}

/** Build a seeder from an explicit list (separate meta table). */
export function createSeederFromList(
  migrations: MigrationModule[],
  sequelize: Sequelize = getSequelize(),
): Umzug<QueryInterface> {
  return new Umzug({
    migrations,
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, modelName: 'seeders_meta' }),
    logger: console,
  });
}

/**
 * Code-first migration runner (Umzug + Sequelize). Numbered `NNNN_subject.ts` files each export
 * `{ up, down }` receiving the QueryInterface as `context`. Applied migrations are tracked in
 * `migrations_meta`. Run as a one-shot task (PROCESS_TYPE=migration).
 */
export function createMigrator(glob: string, sequelize: Sequelize = getSequelize()): Umzug<QueryInterface> {
  return new Umzug({
    migrations: { glob },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, modelName: 'migrations_meta' }),
    logger: console,
  });
}

/** Seeder runner — separate meta table so seeds and schema migrations track independently. */
export function createSeeder(glob: string, sequelize: Sequelize = getSequelize()): Umzug<QueryInterface> {
  return new Umzug({
    migrations: { glob },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, modelName: 'seeders_meta' }),
    logger: console,
  });
}
