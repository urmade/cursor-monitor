import {
  and,
  count,
  desc,
  eq,
  inArray,
  lt,
  sql,
} from 'drizzle-orm';
import type {
  DatabaseAdapter,
  RepositoryPreferenceRecord,
  SyncRunStatus,
} from './adapter';
import { closeDb, getDb, pingDb } from './client';
import {
  branchPreferences,
  conversationPreferences,
  hookEvents,
  repositoryPreferences,
  syncLocks,
  syncRuns,
  teamUsageEvents,
} from './schema';

const REPOSITORY_PREFERENCE_LOCK = 1_987_451_622;

function syncRunStatus(value: string): SyncRunStatus {
  if (
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'skipped'
  ) {
    return value;
  }
  throw new Error(`Unsupported sync run status: ${value}`);
}

function repositoryPreferenceRows(
  rows: Array<{
    repositoryKey: string;
    displayName: string | null;
    mergedIntoKey: string | null;
  }>,
): RepositoryPreferenceRecord[] {
  return rows.map((row) => ({
    repositoryKey: row.repositoryKey,
    displayName: row.displayName,
    mergedIntoKey: row.mergedIntoKey,
  }));
}

export function createPostgresAdapter(): DatabaseAdapter {
  return {
    info: {
      id: 'postgres',
      displayName: 'PostgreSQL',
    },
    ping: pingDb,
    close: closeDb,
    hooks: {
      async insert(event) {
        const inserted = await getDb()
          .insert(hookEvents)
          .values(event)
          .onConflictDoNothing()
          .returning({ id: hookEvents.id });
        return inserted[0]?.id ?? null;
      },
      async listRecent(limit) {
        return getDb()
          .select({
            id: hookEvents.id,
            eventName: hookEvents.eventName,
            conversationId: hookEvents.conversationId,
            conversationKey: hookEvents.conversationKey,
            generationId: hookEvents.generationId,
            repositoryKey: hookEvents.repositoryKey,
            repositoryLabel: hookEvents.repositoryLabel,
            gitBranch: hookEvents.gitBranch,
            workspaceRoot: hookEvents.workspaceRoot,
            userEmail: hookEvents.userEmail,
            model: hookEvents.model,
            status: hookEvents.status,
            durationMs: hookEvents.durationMs,
            occurredAt: hookEvents.occurredAt,
            receivedAt: hookEvents.receivedAt,
          })
          .from(hookEvents)
          .orderBy(desc(hookEvents.occurredAt))
          .limit(limit);
      },
      async listPayloads(ids) {
        if (ids.length === 0) return [];
        return getDb()
          .select({ id: hookEvents.id, payload: hookEvents.payload })
          .from(hookEvents)
          .where(inArray(hookEvents.id, [...ids]));
      },
      async count() {
        const rows = await getDb().select({ value: count() }).from(hookEvents);
        return Number(rows[0]?.value ?? 0);
      },
    },
    usage: {
      async insertDeduplicated(events) {
        if (events.length === 0) return 0;
        const inserted = await getDb()
          .insert(teamUsageEvents)
          .values(events.map((event) => ({ ...event })))
          .onConflictDoNothing()
          .returning({ fingerprint: teamUsageEvents.fingerprint });
        return inserted.length;
      },
      async listRecent(limit) {
        return getDb()
          .select({
            fingerprint: teamUsageEvents.fingerprint,
            conversationId: teamUsageEvents.conversationId,
            conversationKey: teamUsageEvents.conversationKey,
            userEmail: teamUsageEvents.userEmail,
            model: teamUsageEvents.model,
            kind: teamUsageEvents.kind,
            chargedCents: teamUsageEvents.chargedCents,
            occurredAt: teamUsageEvents.occurredAt,
          })
          .from(teamUsageEvents)
          .orderBy(desc(teamUsageEvents.occurredAt))
          .limit(limit);
      },
      async count() {
        const rows = await getDb()
          .select({ value: count() })
          .from(teamUsageEvents);
        return Number(rows[0]?.value ?? 0);
      },
    },
    repositoryPreferences: {
      async list() {
        const rows = await getDb()
          .select({
            repositoryKey: repositoryPreferences.repositoryKey,
            displayName: repositoryPreferences.displayName,
            mergedIntoKey: repositoryPreferences.mergedIntoKey,
          })
          .from(repositoryPreferences);
        return repositoryPreferenceRows(rows);
      },
      async setDisplayName(repositoryKey, displayName, updatedAt) {
        await getDb().transaction(async (transaction) => {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(${REPOSITORY_PREFERENCE_LOCK})`,
          );
          const [existing] = await transaction
            .select({
              mergedIntoKey: repositoryPreferences.mergedIntoKey,
            })
            .from(repositoryPreferences)
            .where(eq(repositoryPreferences.repositoryKey, repositoryKey))
            .limit(1);
          if (displayName === null && !existing?.mergedIntoKey) {
            await transaction
              .delete(repositoryPreferences)
              .where(eq(repositoryPreferences.repositoryKey, repositoryKey));
            return;
          }
          await transaction
            .insert(repositoryPreferences)
            .values({
              repositoryKey,
              displayName,
              mergedIntoKey: existing?.mergedIntoKey ?? null,
              updatedAt,
            })
            .onConflictDoUpdate({
              target: repositoryPreferences.repositoryKey,
              set: { displayName, updatedAt },
            });
        });
      },
      async merge(decide, updatedAt) {
        return getDb().transaction(async (transaction) => {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(${REPOSITORY_PREFERENCE_LOCK})`,
          );
          const rows = await transaction
            .select({
              repositoryKey: repositoryPreferences.repositoryKey,
              displayName: repositoryPreferences.displayName,
              mergedIntoKey: repositoryPreferences.mergedIntoKey,
            })
            .from(repositoryPreferences);
          const current = repositoryPreferenceRows(rows);
          const decision = decide(current);
          const existing = current.find(
            (preference) => preference.repositoryKey === decision.source,
          );
          await transaction
            .insert(repositoryPreferences)
            .values({
              repositoryKey: decision.source,
              displayName: existing?.displayName ?? null,
              mergedIntoKey: decision.targetRoot,
              updatedAt,
            })
            .onConflictDoUpdate({
              target: repositoryPreferences.repositoryKey,
              set: { mergedIntoKey: decision.targetRoot, updatedAt },
            });
          return decision;
        });
      },
      async clearMerge(repositoryKey, updatedAt) {
        await getDb().transaction(async (transaction) => {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(${REPOSITORY_PREFERENCE_LOCK})`,
          );
          const [existing] = await transaction
            .select({ displayName: repositoryPreferences.displayName })
            .from(repositoryPreferences)
            .where(eq(repositoryPreferences.repositoryKey, repositoryKey))
            .limit(1);
          if (!existing?.displayName) {
            await transaction
              .delete(repositoryPreferences)
              .where(eq(repositoryPreferences.repositoryKey, repositoryKey));
            return;
          }
          await transaction
            .update(repositoryPreferences)
            .set({ mergedIntoKey: null, updatedAt })
            .where(eq(repositoryPreferences.repositoryKey, repositoryKey));
        });
      },
    },
    conversationPreferences: {
      async list() {
        return getDb()
          .select({
            conversationKey: conversationPreferences.conversationKey,
            displayName: conversationPreferences.displayName,
          })
          .from(conversationPreferences);
      },
      async setDisplayName(conversationKey, displayName, updatedAt) {
        await getDb()
          .insert(conversationPreferences)
          .values({ conversationKey, displayName, updatedAt })
          .onConflictDoUpdate({
            target: conversationPreferences.conversationKey,
            set: { displayName, updatedAt },
          });
      },
      async delete(conversationKey) {
        await getDb()
          .delete(conversationPreferences)
          .where(eq(conversationPreferences.conversationKey, conversationKey));
      },
    },
    branchPreferences: {
      async list(repositoryKey) {
        return getDb()
          .select({
            repositoryKey: branchPreferences.repositoryKey,
            branchKey: branchPreferences.branchKey,
            displayName: branchPreferences.displayName,
          })
          .from(branchPreferences)
          .where(eq(branchPreferences.repositoryKey, repositoryKey));
      },
      async setDisplayName(preference, updatedAt) {
        await getDb()
          .insert(branchPreferences)
          .values({ ...preference, updatedAt })
          .onConflictDoUpdate({
            target: [
              branchPreferences.repositoryKey,
              branchPreferences.branchKey,
            ],
            set: { displayName: preference.displayName, updatedAt },
          });
      },
      async delete(repositoryKey, branchKey) {
        await getDb()
          .delete(branchPreferences)
          .where(
            and(
              eq(branchPreferences.repositoryKey, repositoryKey),
              eq(branchPreferences.branchKey, branchKey),
            ),
          );
      },
    },
    sync: {
      async latestSuccessfulWindowEnd(source) {
        const [latest] = await getDb()
          .select({ windowEndedAt: syncRuns.windowEndedAt })
          .from(syncRuns)
          .where(and(eq(syncRuns.source, source), eq(syncRuns.status, 'succeeded')))
          .orderBy(desc(syncRuns.startedAt))
          .limit(1);
        return latest?.windowEndedAt ?? null;
      },
      async insertRun(run) {
        await getDb().insert(syncRuns).values(run);
      },
      async updateRun(id, update) {
        await getDb().update(syncRuns).set(update).where(eq(syncRuns.id, id));
      },
      async listRecentRuns(limit) {
        const rows = await getDb()
          .select()
          .from(syncRuns)
          .orderBy(desc(syncRuns.startedAt))
          .limit(limit);
        return rows.map((row) => ({
          ...row,
          status: syncRunStatus(row.status),
        }));
      },
      async tryAcquireLease({ source, ownerId, now, expiresAt }) {
        const db = getDb();
        await db
          .delete(syncLocks)
          .where(and(eq(syncLocks.source, source), lt(syncLocks.expiresAt, now)));
        const inserted = await db
          .insert(syncLocks)
          .values({ source, ownerId, expiresAt })
          .onConflictDoNothing()
          .returning({ source: syncLocks.source });
        return inserted.length === 1;
      },
      async releaseLease(source, ownerId) {
        await getDb()
          .delete(syncLocks)
          .where(
            and(eq(syncLocks.source, source), eq(syncLocks.ownerId, ownerId)),
          );
      },
    },
  };
}
