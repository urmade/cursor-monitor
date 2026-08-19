type Environment = Readonly<Record<string, string | undefined>>;
type SslOption =
  | 'require'
  | 'allow'
  | 'prefer'
  | 'verify-full'
  | false
  | undefined;

function sslOptionForMode(mode: string | undefined): SslOption {
  switch (mode?.trim().toLowerCase()) {
    case undefined:
    case '':
      return undefined;
    case 'disable':
    case 'false':
      return false;
    case 'allow':
    case 'prefer':
    case 'require':
    case 'verify-full':
      return mode.trim().toLowerCase() as Exclude<
        SslOption,
        false | undefined
      >;
    case 'verify-ca':
      return 'verify-full';
    case 'true':
      return 'require';
    default:
      throw new Error(`Unsupported PostgreSQL SSL mode: ${mode}`);
  }
}

export function sslOptionForUrl(
  url: string,
  environment: Environment = process.env,
): SslOption {
  try {
    const parsed = new URL(url);
    const urlMode = parsed.searchParams.get('sslmode')?.toLowerCase();
    if (urlMode === 'disable') return false;
    if (urlMode) return undefined;

    const environmentMode =
      environment.PGSSLMODE ??
      environment.DB_SSL;
    const configured = sslOptionForMode(environmentMode);
    if (configured !== undefined) return configured;

    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return local ? false : 'require';
  } catch {
    return sslOptionForMode(environment.PGSSLMODE ?? environment.DB_SSL) ??
      'require';
  }
}
