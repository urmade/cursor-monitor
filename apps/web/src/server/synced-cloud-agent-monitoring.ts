/**
 * Load cadence-synced Cloud Agent / automation runs for Monitoring's separate
 * section. Existing live user-key Monitoring is unchanged.
 */
import {
  enrichSyncedCloudAgentRuns,
  listSyncedCloudAgentRuns,
  readLastAutomationUsageSync,
  type SyncedCloudAgentRun,
} from '@nexus/core';
import type { CursorClient } from '@nexus/cursor-client';
import { optionalSession } from './session';

export type SyncedMonitoringSection = {
  runs: SyncedCloudAgentRun[];
  lastSyncAt: string | null;
  error: string | null;
};

export async function loadSyncedMonitoringSection(opts?: {
  clients?: CursorClient[];
  limit?: number;
}): Promise<SyncedMonitoringSection> {
  const session = await optionalSession();
  if (!session) {
    return { runs: [], lastSyncAt: null, error: null };
  }

  try {
    let runs = await listSyncedCloudAgentRuns(session.ctx, {
      limit: opts?.limit ?? 40,
    });
    const clients = opts?.clients ?? [];
    if (clients.length > 0 && runs.some((r) => !r.enriched)) {
      runs = await enrichSyncedCloudAgentRuns(session.ctx, runs, clients, {
        maxEnrich: 16,
      });
    }
    const last = await readLastAutomationUsageSync();
    return {
      runs,
      lastSyncAt: last?.at ?? null,
      error: null,
    };
  } catch (err) {
    return {
      runs: [],
      lastSyncAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
