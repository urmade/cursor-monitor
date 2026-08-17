import { canonicalRepository, NO_REPOSITORY_KEY } from './identity';

export type RepositoryPreference = {
  repositoryKey: string;
  displayName: string | null;
  mergedIntoKey: string | null;
};

export class RepositoryPreferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryPreferenceError';
  }
}

export function preferenceMap(
  preferences: readonly RepositoryPreference[],
): Map<string, RepositoryPreference> {
  return new Map(
    preferences.map((preference) => {
      const repositoryKey = canonicalRepository(preference.repositoryKey);
      return [
        repositoryKey,
        {
          repositoryKey,
          displayName: preference.displayName?.trim() || null,
          mergedIntoKey: preference.mergedIntoKey
            ? canonicalRepository(preference.mergedIntoKey)
            : null,
        },
      ];
    }),
  );
}

/** Resolve a transitive merge chain. Malformed cycles stop deterministically. */
export function resolveMergeRoot(
  repository: string,
  preferences: ReadonlyMap<string, RepositoryPreference>,
): string {
  let current = canonicalRepository(repository);
  if (current === NO_REPOSITORY_KEY) return current;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = preferences.get(current)?.mergedIntoKey;
    if (!next || next === NO_REPOSITORY_KEY) return current;
    current = canonicalRepository(next);
  }
  return [...seen].sort()[0] ?? current;
}

export function validateRepositoryMerge(
  sourceValue: string,
  targetValue: string,
  preferences: ReadonlyMap<string, RepositoryPreference>,
): { source: string; targetRoot: string } {
  const source = canonicalRepository(sourceValue);
  const target = canonicalRepository(targetValue);
  if (source === NO_REPOSITORY_KEY || target === NO_REPOSITORY_KEY) {
    throw new RepositoryPreferenceError(
      'The “No repository” bucket cannot participate in a merge.',
    );
  }
  if (source === target) {
    throw new RepositoryPreferenceError('A repository cannot merge into itself.');
  }
  const targetRoot = resolveMergeRoot(target, preferences);
  if (targetRoot === source) {
    throw new RepositoryPreferenceError('That merge would create a cycle.');
  }
  for (const candidate of preferences.values()) {
    if (
      candidate.repositoryKey !== source &&
      resolveMergeRoot(candidate.repositoryKey, preferences) === source
    ) {
      throw new RepositoryPreferenceError(
        'Detach repositories from this project before merging it into another.',
      );
    }
  }
  return { source, targetRoot };
}
