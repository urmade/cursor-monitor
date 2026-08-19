import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateDatabase } from './runtime';

export async function execMigrations(connectionUrl?: string): Promise<void> {
  await migrateDatabase(connectionUrl);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  execMigrations().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
