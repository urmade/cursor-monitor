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
import { getDatabase } from '@cursor-monitor/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { repositoryPath, safeInternalPath } from '@/src/lib/paths';
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
  if (repository) {
    const path = repositoryPath(repository);
    revalidatePath(path);
    revalidatePath(`${path}/rename`);
  }
}

function finish(form: FormData, repositoryKey: string): never {
  refresh(repositoryKey);
  redirect(safeInternalPath(text(form, 'returnTo'), repositoryPath(repositoryKey)));
}

export async function renameRepository(form: FormData): Promise<void> {
  await requireAdmin();
  const repositoryKey = canonicalRepository(text(form, 'repositoryKey'));
  const displayName = text(form, 'displayName');
  if (repositoryKey === NO_REPOSITORY_KEY) {
    throw new Error('The “No repository” bucket cannot be renamed.');
  }
  assertDisplayName(displayName);
  await getDatabase().repositoryPreferences.setDisplayName(
    repositoryKey,
    displayName || null,
    new Date(),
  );
  finish(form, repositoryKey);
}

export async function mergeRepository(form: FormData): Promise<void> {
  await requireAdmin();
  const sourceValue = text(form, 'source');
  const targetValue = text(form, 'target');
  const decision = await getDatabase().repositoryPreferences.merge(
    (rows) => {
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
      return {
        source: validated.source,
        targetRoot: validated.targetRoot,
      };
    },
    new Date(),
  );
  refresh(decision.targetRoot);
}

export async function unmergeRepository(form: FormData): Promise<void> {
  await requireAdmin();
  const repositoryKey = canonicalRepository(text(form, 'repositoryKey'));
  await getDatabase().repositoryPreferences.clearMerge(
    repositoryKey,
    new Date(),
  );
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
    await getDatabase().conversationPreferences.delete(conversationKey);
  } else {
    await getDatabase().conversationPreferences.setDisplayName(
      conversationKey,
      displayName,
      new Date(),
    );
  }
  finish(form, text(form, 'repositoryKey'));
}

export async function renameBranch(form: FormData): Promise<void> {
  await requireAdmin();
  const repositoryKey = canonicalRepository(text(form, 'repositoryKey'));
  const branchKey = text(form, 'branchKey');
  const displayName = text(form, 'displayName');
  if (!branchKey) throw new Error('Missing branch.');
  assertDisplayName(displayName);
  if (!displayName) {
    await getDatabase().branchPreferences.delete(repositoryKey, branchKey);
  } else {
    await getDatabase().branchPreferences.setDisplayName(
      { repositoryKey, branchKey, displayName },
      new Date(),
    );
  }
  finish(form, repositoryKey);
}

export async function runTeamSync(): Promise<void> {
  await requireAdmin();
  await syncTeamUsage();
  refresh();
}
