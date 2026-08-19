export function repositoryPath(repositoryKey: string): string {
  return `/repositories/${encodeURIComponent(repositoryKey)}`;
}
