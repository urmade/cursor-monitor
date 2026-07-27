import { eq } from 'drizzle-orm';
import { featureFlags, type Db } from '@nexus/db';
import type { FeatureFlags } from './context';

export function createFlagReader(db: Db): FeatureFlags {
  return {
    async isEnabled(key: string, projectId?: string): Promise<boolean> {
      const envKey = `FLAG_${key.replace(/\./g, '_').toUpperCase()}`;
      const env = process.env[envKey];
      if (env === '1' || env === 'true') return true;
      if (env === '0' || env === 'false') return false;

      const row = await db.query.featureFlags.findFirst({
        where: eq(featureFlags.key, key),
      });
      if (!row) return false;
      if (row.enabled) return true;
      if (projectId && row.enabledForProjectIds?.includes(projectId)) return true;
      return false;
    },
  };
}
