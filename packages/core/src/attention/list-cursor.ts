export function decodeInboxCursor(
  cursor: string,
): { s: number; t: string; i: string } | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      s: number;
      t: string;
      i: string;
    };
    if (typeof raw.s !== 'number' || !raw.t || !raw.i) return null;
    return raw;
  } catch {
    return null;
  }
}
