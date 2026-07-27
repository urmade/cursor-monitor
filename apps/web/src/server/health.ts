import { getMigrationVersion, pingDb } from '@nexus/db';
import type { StatusBarHealth } from '@nexus/ui';

export async function getHealthSnapshot(): Promise<StatusBarHealth> {
  try {
    const ok = await pingDb();
    if (!ok) return { db: 'unavailable' };
    const migrationVersion = await getMigrationVersion();
    return {
      db: 'ok',
      migrationVersion: migrationVersion ?? undefined,
    };
  } catch {
    return { db: 'error' };
  }
}
