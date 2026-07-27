/** Local Docker/dev Postgres has no TLS; Supabase requires it. */
export function sslOptionForUrl(url: string): 'require' | undefined {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return undefined;
    }
  } catch {
    // fall through
  }
  if (process.env.DB_SSL === 'disable') return undefined;
  return 'require';
}
