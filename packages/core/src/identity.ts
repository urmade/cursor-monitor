export const NO_REPOSITORY_KEY = '__no_repository__';
export const UNKNOWN_CONVERSATION_KEY = '__unknown_conversation__';

export function canonicalRepository(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || NO_REPOSITORY_KEY;
}

export function canonicalConversation(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || UNKNOWN_CONVERSATION_KEY;
}

/** Convert git remote URLs and path-like values into an owner/repository label. */
export function normalizeRepositoryLabel(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  let normalized = value.trim().replace(/\.git$/i, '');
  normalized = normalized
    .replace(/^git\+ssh:\/\//i, '')
    .replace(/^ssh:\/\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^git@/i, '');
  const scp = normalized.match(/^[^/:]+:(.+)$/);
  if (scp?.[1]) normalized = scp[1];
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length >= 2) {
    return `${segments.at(-2)}/${segments.at(-1)}`;
  }
  return normalized || null;
}

export function displayRepositoryKey(key: string): string {
  return key === NO_REPOSITORY_KEY ? 'No repository' : key;
}

export function displayConversationKey(key: string): string {
  if (key === UNKNOWN_CONVERSATION_KEY) return 'Unknown conversation';
  return key.length <= 16 ? key : `${key.slice(0, 12)}…`;
}
