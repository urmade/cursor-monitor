import {
  getDatabase,
  newId,
  type DatabaseAdapter,
  type NewUsageEvent,
} from '@cursor-monitor/db';
import {
  credentialsFromEnv,
  TeamApiClient,
  usageConversationKey,
  usageEventFingerprint,
  type ListUsageResult,
  type UsageEvent,
} from '@cursor-monitor/team-api';

const SOURCE = 'cursor-team-usage';
const INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 60 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const CHUNK_SIZE = 500;
const MINIMUM_SPLIT_WINDOW_MS = 5 * 60 * 1000;
const MAXIMUM_SPLIT_DEPTH = 12;

export type TeamSyncResult = {
  status: 'succeeded' | 'failed' | 'skipped';
  fetched: number;
  inserted: number;
  pages: number;
  truncated: boolean;
  message?: string;
};

function parseTimestamp(value: string): Date {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
}

function eventConversationId(event: UsageEvent): string | null {
  const record = event as Record<string, unknown>;
  const value =
    event.conversationId ?? record['conversation_id'] ?? record['conversationID'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function listCompleteWindow(
  client: Pick<TeamApiClient, 'listUsageEvents'>,
  startDate: number,
  endDate: number,
  deadlineAt: number,
  depth = 0,
): Promise<ListUsageResult> {
  const listed = await client.listUsageEvents({
    startDate,
    endDate,
    deadlineAt,
  });
  if (!listed.truncated) return listed;
  if (
    depth >= MAXIMUM_SPLIT_DEPTH ||
    endDate - startDate <= MINIMUM_SPLIT_WINDOW_MS
  ) {
    return listed;
  }
  const midpoint = Math.floor(startDate + (endDate - startDate) / 2);
  const older = await listCompleteWindow(
    client,
    startDate,
    midpoint,
    deadlineAt,
    depth + 1,
  );
  const newer = await listCompleteWindow(
    client,
    midpoint,
    endDate,
    deadlineAt,
    depth + 1,
  );
  return {
    events: [...older.events, ...newer.events],
    pages: older.pages + newer.pages,
    truncated: older.truncated || newer.truncated,
  };
}

export async function syncTeamUsage(options?: {
  database?: DatabaseAdapter;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  client?: Pick<TeamApiClient, 'listUsageEvents'>;
}): Promise<TeamSyncResult> {
  const database = options?.database ?? getDatabase();
  const now = options?.now ?? new Date();
  const credentials = credentialsFromEnv(options?.env);
  const previousWindowEnd =
    await database.sync.latestSuccessfulWindowEnd(SOURCE);
  const windowStartedAt = previousWindowEnd
    ? new Date(previousWindowEnd.getTime() - OVERLAP_MS)
    : new Date(now.getTime() - INITIAL_LOOKBACK_MS);

  if (!credentials) {
    await database.sync.insertRun({
      id: newId(),
      source: SOURCE,
      status: 'skipped',
      windowStartedAt,
      windowEndedAt: now,
      error:
        'Configure CURSOR_TEAM_API_KEY or CURSOR_ORGANIZATION_API_KEY plus CURSOR_ORGANIZATION_ID.',
      completedAt: now,
    });
    return {
      status: 'skipped',
      fetched: 0,
      inserted: 0,
      pages: 0,
      truncated: false,
      message: 'Cursor Team API credentials are not configured.',
    };
  }

  const lockOwnerId = newId();
  if (
    !(await database.sync.tryAcquireLease({
      source: SOURCE,
      ownerId: lockOwnerId,
      now,
      expiresAt: new Date(now.getTime() + LOCK_MS),
    }))
  ) {
    return {
      status: 'skipped',
      fetched: 0,
      inserted: 0,
      pages: 0,
      truncated: false,
      message: 'A Team API sync is already running.',
    };
  }

  const runId = newId();
  await database.sync.insertRun({
    id: runId,
    source: SOURCE,
    status: 'running',
    windowStartedAt,
    windowEndedAt: now,
  });

  try {
    const client =
      options?.client ??
      new TeamApiClient({
        credentials,
        baseUrl: options?.env?.CURSOR_API_BASE_URL ?? process.env.CURSOR_API_BASE_URL,
      });
    const listed = await listCompleteWindow(
      client,
      windowStartedAt.getTime(),
      now.getTime(),
      Date.now() + 45_000,
    );
    let insertedCount = 0;

    for (let offset = 0; offset < listed.events.length; offset += CHUNK_SIZE) {
      const chunk = listed.events.slice(offset, offset + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      const events: NewUsageEvent[] = chunk.map((event) => ({
        fingerprint: usageEventFingerprint(event),
        occurredAt: parseTimestamp(event.timestamp),
        conversationId: eventConversationId(event),
        conversationKey: usageConversationKey(event),
        userEmail: event.userEmail?.trim() || null,
        model: event.model?.trim() || null,
        kind: event.kind?.trim() || null,
        teamId:
          typeof event.teamId === 'number' && Number.isFinite(event.teamId)
            ? Math.trunc(event.teamId)
            : null,
        chargedCents:
          typeof event.chargedCents === 'number' &&
          Number.isFinite(event.chargedCents)
            ? event.chargedCents
            : null,
        payload: { ...event },
        fetchedAt: now,
      }));
      insertedCount += await database.usage.insertDeduplicated(events);
    }

    if (listed.truncated) {
      const message =
        'Cursor Team API window remained truncated after recursive splitting; successful watermark was not advanced.';
      await database.sync.updateRun(runId, {
        status: 'failed',
        fetchedCount: listed.events.length,
        insertedCount,
        pages: listed.pages,
        truncated: true,
        error: message,
        completedAt: new Date(),
      });
      return {
        status: 'failed',
        fetched: listed.events.length,
        inserted: insertedCount,
        pages: listed.pages,
        truncated: true,
        message,
      };
    }

    await database.sync.updateRun(runId, {
      status: 'succeeded',
      fetchedCount: listed.events.length,
      insertedCount,
      pages: listed.pages,
      truncated: listed.truncated,
      completedAt: new Date(),
    });
    return {
      status: 'succeeded',
      fetched: listed.events.length,
      inserted: insertedCount,
      pages: listed.pages,
      truncated: listed.truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.sync.updateRun(runId, {
      status: 'failed',
      error: message.slice(0, 1000),
      completedAt: new Date(),
    });
    return {
      status: 'failed',
      fetched: 0,
      inserted: 0,
      pages: 0,
      truncated: false,
      message,
    };
  } finally {
    await database.sync.releaseLease(SOURCE, lockOwnerId);
  }
}
