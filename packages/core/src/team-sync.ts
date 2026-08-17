import {
  getDb,
  newId,
  syncLocks,
  syncRuns,
  teamUsageEvents,
  type Db,
} from '@cursor-monitor/db';
import {
  credentialsFromEnv,
  TeamApiClient,
  usageConversationKey,
  usageEventFingerprint,
  type UsageEvent,
} from '@cursor-monitor/team-api';
import { and, desc, eq, lt } from 'drizzle-orm';

const SOURCE = 'cursor-team-usage';
const INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 60 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const CHUNK_SIZE = 500;

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

async function acquireLock(db: Db, now: Date): Promise<boolean> {
  await db
    .delete(syncLocks)
    .where(and(eq(syncLocks.source, SOURCE), lt(syncLocks.expiresAt, now)));
  const inserted = await db
    .insert(syncLocks)
    .values({
      source: SOURCE,
      expiresAt: new Date(now.getTime() + LOCK_MS),
    })
    .onConflictDoNothing()
    .returning({ source: syncLocks.source });
  return inserted.length === 1;
}

async function releaseLock(db: Db): Promise<void> {
  await db.delete(syncLocks).where(eq(syncLocks.source, SOURCE));
}

export async function syncTeamUsage(options?: {
  db?: Db;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  client?: TeamApiClient;
}): Promise<TeamSyncResult> {
  const db = options?.db ?? getDb();
  const now = options?.now ?? new Date();
  const credentials = credentialsFromEnv(options?.env);
  const [previous] = await db
    .select({ windowEndedAt: syncRuns.windowEndedAt })
    .from(syncRuns)
    .where(
      and(eq(syncRuns.source, SOURCE), eq(syncRuns.status, 'succeeded')),
    )
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  const windowStartedAt = previous
    ? new Date(previous.windowEndedAt.getTime() - OVERLAP_MS)
    : new Date(now.getTime() - INITIAL_LOOKBACK_MS);

  if (!credentials) {
    await db.insert(syncRuns).values({
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

  if (!(await acquireLock(db, now))) {
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
  await db.insert(syncRuns).values({
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
    const listed = await client.listUsageEvents({
      startDate: windowStartedAt.getTime(),
      endDate: now.getTime(),
    });
    let insertedCount = 0;

    for (let offset = 0; offset < listed.events.length; offset += CHUNK_SIZE) {
      const chunk = listed.events.slice(offset, offset + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      const inserted = await db
        .insert(teamUsageEvents)
        .values(
          chunk.map((event) => ({
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
          })),
        )
        .onConflictDoNothing()
        .returning({ fingerprint: teamUsageEvents.fingerprint });
      insertedCount += inserted.length;
    }

    await db
      .update(syncRuns)
      .set({
        status: 'succeeded',
        fetchedCount: listed.events.length,
        insertedCount,
        pages: listed.pages,
        truncated: listed.truncated,
        completedAt: new Date(),
      })
      .where(eq(syncRuns.id, runId));
    return {
      status: 'succeeded',
      fetched: listed.events.length,
      inserted: insertedCount,
      pages: listed.pages,
      truncated: listed.truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        error: message.slice(0, 1000),
        completedAt: new Date(),
      })
      .where(eq(syncRuns.id, runId));
    return {
      status: 'failed',
      fetched: 0,
      inserted: 0,
      pages: 0,
      truncated: false,
      message,
    };
  } finally {
    await releaseLock(db);
  }
}
