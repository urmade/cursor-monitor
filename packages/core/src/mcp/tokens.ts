import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { mcpTokens, newId, type Db } from '@nexus/db';

export type McpTokenRecord = typeof mcpTokens.$inferSelect;

export type MintedToken = {
  tokenId: string;
  /** Raw bearer secret — never persist or log. */
  rawToken: string;
  tokenPrefix: string;
  expiresAt: Date;
};

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function mintRawToken(): { raw: string; prefix: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const prefix = raw.slice(0, 8);
  return { raw, prefix, hash: hashToken(raw) };
}

export async function createMcpToken(
  db: Db,
  input: {
    runId: string;
    workItemId: string;
    projectId: string;
    scopes?: string[];
    ttlMinutes?: number;
  },
): Promise<MintedToken> {
  const { raw, prefix, hash } = mintRawToken();
  const ttl = input.ttlMinutes ?? 90;
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  const id = newId();
  await db.insert(mcpTokens).values({
    id,
    tokenHash: hash,
    tokenPrefix: prefix,
    runId: input.runId,
    workItemId: input.workItemId,
    projectId: input.projectId,
    scopes: input.scopes ?? ['mcp'],
    expiresAt,
  });
  return { tokenId: id, rawToken: raw, tokenPrefix: prefix, expiresAt };
}

export async function revokeRunTokens(db: Db, runId: string): Promise<void> {
  await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.runId, runId), isNull(mcpTokens.revokedAt)));
}

export async function verifyMcpToken(
  db: Db,
  rawToken: string,
): Promise<
  | { ok: true; token: McpTokenRecord }
  | { ok: false; code: 'unauthorized' | 'forbidden'; message: string }
> {
  if (!rawToken || rawToken.length < 16) {
    return { ok: false, code: 'unauthorized', message: 'Missing or invalid token' };
  }
  const hash = hashToken(rawToken);
  const token = await db.query.mcpTokens.findFirst({
    where: eq(mcpTokens.tokenHash, hash),
  });
  if (!token) {
    // Constant-time-ish compare against dummy to reduce timing oracle.
    const dummy = Buffer.from(hash, 'hex');
    timingSafeEqual(dummy, dummy);
    return { ok: false, code: 'unauthorized', message: 'Unknown token' };
  }
  if (token.revokedAt) {
    return { ok: false, code: 'forbidden', message: 'Token revoked' };
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, code: 'forbidden', message: 'Token expired' };
  }

  await db
    .update(mcpTokens)
    .set({
      lastUsedAt: new Date(),
      useCount: token.useCount + 1,
    })
    .where(eq(mcpTokens.id, token.id));

  return { ok: true, token };
}
