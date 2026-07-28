import { and, eq, isNull } from 'drizzle-orm';
import { apiTokens, newId } from '@nexus/db';
import type { ApiScope } from '@nexus/contracts';
import { parseApiScopes } from '@nexus/contracts';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { hashToken, mintRawToken } from '../mcp/tokens';
import { ok, err, type Result } from '../result';
import { timingSafeEqual, createHash } from 'node:crypto';

export type MintedApiToken = {
  tokenId: string;
  plaintext: string;
  prefix: string;
};

export async function createApiToken(
  ctx: ServiceContext,
  input: {
    projectId: string;
    name: string;
    scopes: string[];
    expiresAt?: Date | null;
  },
): Promise<Result<MintedApiToken, CoreError>> {
  let scopes: ApiScope[];
  try {
    scopes = parseApiScopes(input.scopes);
  } catch {
    return err(coreError('validation', 'Invalid scope'));
  }
  if (scopes.length === 0) {
    return err(coreError('validation', 'At least one scope is required'));
  }

  const { raw, prefix } = mintRawToken();
  const plaintext = `nxpat_${raw}`;
  const id = newId();
  const userId = ctx.actor.kind === 'human' ? ctx.actor.userId : null;

  await ctx.db.insert(apiTokens).values({
    id,
    projectId: input.projectId,
    name: input.name,
    tokenHash: hashToken(plaintext),
    tokenPrefix: prefix,
    scopes,
    createdByUserId: userId,
    expiresAt: input.expiresAt ?? null,
  });

  return ok({ tokenId: id, plaintext, prefix });
}

export async function revokeApiToken(
  ctx: ServiceContext,
  tokenId: string,
): Promise<Result<void, CoreError>> {
  await ctx.db
    .update(apiTokens)
    .set({ revokedAt: ctx.clock() })
    .where(eq(apiTokens.id, tokenId));
  return ok(undefined);
}

export type VerifiedApiToken = typeof apiTokens.$inferSelect;

export async function verifyApiToken(
  db: ServiceContext['db'],
  rawToken: string,
): Promise<
  | { ok: true; token: VerifiedApiToken }
  | { ok: false; code: 'unauthorized' | 'forbidden'; message: string }
> {
  if (!rawToken?.startsWith('nxpat_') || rawToken.length < 20) {
    return { ok: false, code: 'unauthorized', message: 'Invalid token' };
  }
  const hash = hashToken(rawToken);
  const token = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, hash),
  });
  if (!token) {
    const dummy = Buffer.from(createHash('sha256').update('x').digest('hex'), 'hex');
    timingSafeEqual(dummy, dummy);
    return { ok: false, code: 'unauthorized', message: 'Unknown token' };
  }
  if (token.revokedAt) {
    return { ok: false, code: 'forbidden', message: 'Token revoked' };
  }
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, code: 'forbidden', message: 'Token expired' };
  }

  await db
    .update(apiTokens)
    .set({
      lastUsedAt: new Date(),
      useCount: token.useCount + 1,
    })
    .where(eq(apiTokens.id, token.id));

  return { ok: true, token };
}

export function tokenHasScope(token: VerifiedApiToken, scope: ApiScope): boolean {
  return token.scopes.includes(scope);
}

export async function listApiTokens(
  ctx: ServiceContext,
  projectId: string,
): Promise<typeof apiTokens.$inferSelect[]> {
  return ctx.db.query.apiTokens.findMany({
    where: and(eq(apiTokens.projectId, projectId), isNull(apiTokens.revokedAt)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}
