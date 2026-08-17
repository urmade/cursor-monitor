'use server';

import {
  canonicalConversation,
  canonicalRepository,
  NO_REPOSITORY_KEY,
  preferenceMap,
  syncTeamUsage,
  UNKNOWN_CONVERSATION_KEY,
  validateRepositoryMerge,
} from '@cursor-monitor/core';
import {
  branchPreferences,
  conversationPreferences,
  getDb,
  repositoryPreferences,
} from '@cursor-monitor/db';
import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from './identity';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function assertDisplayName(value: string): void {
  if (value.length > 120) throw new Error('Display names must be 120 characters or fewer.');
}

function refresh(repository?: string): void {
  revalidatePath('/');
  revalidatePath('/settings');
  if (repository) revalidatePath(`/repositories/${encodeURIComponent(repository)}`);
}

export async function renameRepository(form: FormData): Promise<void> {
  await requireAdmin();
  const repositoryKey = canonicalRepository(text(form, 'repositoryKey'));
  const displayName = text(form, 'displayName');
  if (repositoryKey === NO_REPOSITORY_KEY) {
    throw new Error('The “No repository” bucket cannot be renamed.');
  }
  assertDisplayName(displayName);
  const db = getDb();
  const [existing] = await db
    .select()
    .from(repositoryPreferences)
    .where(eq(repositoryPreferences.repositoryKey, repositoryKey))
    .limit(1);
  if (!displayName && !existing?.mergedIntoKey) {
    await db
      .delete(repositoryPreferences)
      .where(eq(repositoryPreferences.repositoryKey, repositoryKey));
  } else {
    await db
      .insert(repositoryPreferences)
      .values({
        repositoryKey,
        displayName: displayName || null,
        mergedIntoKey: existing?.mergedIntoKey ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: repositoryPreferences.repositoryKey,
        set: { displayName: displayName || null, updatedAt: new Date() },
      });
  }
  refresh(repositoryKey);
}

export async function mergeRepository(form: FormData): Promise<void> {
  await requireAdmin();
  const sourceValue = text(form, 'source');
  const targetValue = text(form, 'target');
  let targetRoot = canonicalRepository(targetValue);
  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(1987451622)`);
    const rows = await transaction.select().from(repositoryPreferences);
    const preferences = preferenceMap(
      rows.map((row) => ({
        repositoryKey: row.repositoryKey,
        displayName: row.displayName,
        mergedIntoKey: row.mergedIntoKey,
      })),
    );
    const validated = validateRepositoryMerge(
      sourceValue,
      targetValue,
      preferences,
    );
    targetRoot = validated.targetRoot;
    const existing = preferences.get(validated.source);
    await transaction
      .insert(repositoryPreferences)
      .values({
        repositoryKey: validated.source,
        displayName: existing?.displayName ?? null,
        mergedIntoKey: validated.targetRoot,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: repositoryPreferences.repositoryKey,
        set: { mergedIntoKey: validated.targetRoot, updatedAt: new Date() },
      });
  });
  refresh(targetRoot);
}

export async function unmergeRepository(form: FormData): Promise<void> {
  await requireAdmin();
  const repositoryKey = canonicalRepository(text(form, 'repositoryKey'));
  const db = getDb();
  const [existing] = await db
    .select()
    .from(repositoryPreferences)
    .where(eq(repositoryPreferences.repositoryKey, repositoryKey))
    .limit(1);
  if (!existing?.displayName) {
    await db
      .delete(repositoryPreferences)
      .where(eq(repositoryPreferences.repositoryKey, repositoryKey));
  } else {
    await db
      .update(repositoryPreferences)
      .set({ mergedIntoKey: null, updatedAt: new Date() })
      .where(eq(repositoryPreferences.repositoryKey, repositoryKey));
  }
  refresh(repositoryKey);
}

export async function renameConversation(form: FormData): Promise<void> {
  await requireAdmin();
  const conversationKey = canonicalConversation(text(form, 'conversationKey'));
  const displayName = text(form, 'displayName');
  if (conversationKey === UNKNOWN_CONVERSATION_KEY) {
    throw new Error('Unknown conversations cannot be renamed.');
  }
  assertDisplayName(displayName);
  if (!displayName) {
    await getDb()
      .delete(conversationPreferences)
      .where(eq(conversationPreferences.conversationKey, conversationKey));
  } else {
    await getDb()
      .insert(conversationPreferences)
      .values({ conversationKey, displayName, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: conversationPreferences.conversationKey,
        set: { displayName, updatedAt: new Date() },
      });
  }
  refresh(text(form, 'repositoryKey'));
}

export async function renameBranch(form: FormData): Promise<void> {
  await requireAdmin();
  const repositoryKey = canonicalRepository(text(form, 'repositoryKey'));
  const branchKey = text(form, 'branchKey');
  const displayName = text(form, 'displayName');
  if (!branchKey) throw new Error('Missing branch.');
  assertDisplayName(displayName);
  const db = getDb();
  if (!displayName) {
    await db
      .delete(branchPreferences)
      .where(
        and(
          eq(branchPreferences.repositoryKey, repositoryKey),
          eq(branchPreferences.branchKey, branchKey),
        ),
      );
  } else {
    await db
      .insert(branchPreferences)
      .values({ repositoryKey, branchKey, displayName, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [branchPreferences.repositoryKey, branchPreferences.branchKey],
        set: { displayName, updatedAt: new Date() },
      });
  }
  refresh(repositoryKey);
}

export async function runTeamSync(): Promise<void> {
  await requireAdmin();
  await syncTeamUsage();
  refresh();
}
