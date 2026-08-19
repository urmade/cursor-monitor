export function repositoryPath(repositoryKey: string): string {
  return `/repositories/${encodeURIComponent(repositoryKey)}`;
}

export function renamePath(
  repositoryKey: string,
  target?: { conversation?: string; branch?: string },
): string {
  const base = `${repositoryPath(repositoryKey)}/rename`;
  if (target?.conversation) {
    return `${base}?conversation=${encodeURIComponent(target.conversation)}`;
  }
  if (target?.branch) {
    return `${base}?branch=${encodeURIComponent(target.branch)}`;
  }
  return base;
}

export function safeInternalPath(
  value: string | null | undefined,
  fallback: string,
): string {
  if (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !value.includes('://')
  ) {
    return value;
  }
  return fallback;
}
