export function sslOptionForUrl(url: string): 'require' | false {
  try {
    const host = new URL(url).hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return local || process.env.DB_SSL === 'disable' ? false : 'require';
  } catch {
    return process.env.DB_SSL === 'disable' ? false : 'require';
  }
}
