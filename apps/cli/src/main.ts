import 'reflect-metadata';
import { createMigratorFromList, createSeederFromList, closeSequelize } from '@aegis/db';
import { loadServiceEnv, Logger } from '@aegis/service-core';
import { migrations } from './migrations';
import { seeders } from './seeders';

loadServiceEnv('cli');
Logger.init('cli');

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const migrator = createMigratorFromList(migrations);
  const seeder = createSeederFromList(seeders);

  switch (cmd) {
    case 'migrate': {
      const done = await migrator.up();
      console.log('migrated:', done.map((m) => m.name));
      break;
    }
    case 'migrate-seeders': {
      const done = await seeder.up();
      console.log('seeded:', done.map((m) => m.name));
      break;
    }
    case 'show-migrations': {
      const executed = await migrator.executed();
      const pending = await migrator.pending();
      console.log('executed:', executed.map((m) => m.name));
      console.log('pending:', pending.map((m) => m.name));
      break;
    }
    case 'reverse-last': {
      const done = await migrator.down();
      console.log('reverted:', done.map((m) => m.name));
      break;
    }
    default:
      console.error('usage: migrate | migrate-seeders | show-migrations | reverse-last');
      process.exitCode = 1;
  }
  await closeSequelize();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
