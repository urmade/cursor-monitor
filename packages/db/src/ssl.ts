type Environment = Readonly<Record<string, string | undefined>>;

export function sslOptionForUrl(
  url: string,
  environment: Environment = process.env,
): 'require' | false | undefined {
  try {
    const parsed = new URL(url);
    const urlMode = parsed.searchParams.get('sslmode')?.toLowerCase();
    if (urlMode === 'disable') return false;
    if (urlMode) return undefined;

    const environmentMode = (
      environment.PGSSLMODE ??
      environment.DB_SSL
    )?.toLowerCase();
    if (environmentMode === 'disable') return false;
    if (environmentMode) return 'require';

    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return local ? false : 'require';
  } catch {
    return environment.PGSSLMODE === 'disable' ||
      environment.DB_SSL === 'disable'
      ? false
      : 'require';
  }
}
