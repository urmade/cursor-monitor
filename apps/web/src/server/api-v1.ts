import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys, newId, projects } from '@nexus/db';
import type { Db } from '@nexus/db';
import {
  checkRateLimit,
  checkRateLimitWindow,
  createContext,
  verifyApiToken,
  type ServiceContext,
} from '@nexus/core';
import { createFlagReader } from '@nexus/core';
import type { Actor } from '@nexus/contracts';

export type ApiV1Auth =
  | { ok: true; ctx: ServiceContext; tokenId: string; projectId: string; scopes: string[] }
  | { ok: false; status: number; body: ProblemDetail };

export type ProblemDetail = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  missing_scope?: string;
  request_id?: string;
};

export function problem(
  status: number,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
): ProblemDetail {
  return {
    type: 'about:blank',
    title,
    status,
    ...(detail ? { detail } : {}),
    ...extra,
  };
}

export async function authenticateApiV1(
  db: Db,
  req: Request,
): Promise<ApiV1Auth> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      body: problem(401, 'Unauthorized', 'Missing bearer token'),
    };
  }
  const raw = auth.slice('Bearer '.length).trim();
  const verified = await verifyApiToken(db, raw);
  if (!verified.ok) {
    return {
      ok: false,
      status: verified.code === 'forbidden' ? 403 : 401,
      body: problem(
        verified.code === 'forbidden' ? 403 : 401,
        verified.code === 'forbidden' ? 'Forbidden' : 'Unauthorized',
        verified.message,
      ),
    };
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, verified.token.projectId),
  });
  if (!project) {
    return {
      ok: false,
      status: 403,
      body: problem(403, 'Forbidden', 'Token project not found'),
    };
  }

  const flags = createFlagReader(db);
  const enabled = await flags.isEnabled('p8.api', verified.token.projectId);
  if (!enabled) {
    return {
      ok: false,
      status: 403,
      body: problem(403, 'Forbidden', 'Public API is not enabled for this project'),
    };
  }

  const actor: Actor = {
    kind: 'api_token',
    tokenId: verified.token.id,
    projectId: verified.token.projectId,
    scopes: verified.token.scopes,
  };

  const ctx = createContext({
    db,
    orgId: project.orgId,
    actor,
    flags,
  });

  return {
    ok: true,
    ctx,
    tokenId: verified.token.id,
    projectId: verified.token.projectId,
    scopes: verified.token.scopes,
  };
}

export async function enforceRateLimit(tokenId: string): Promise<
  | { ok: true }
  | { ok: false; retryAfterSec: number }
> {
  const burst = await checkRateLimitWindow(`api:${tokenId}:sec`, 60, 1);
  if (!burst.allowed) {
    return { ok: false, retryAfterSec: burst.retryAfterSec || 1 };
  }
  const minute = await checkRateLimit(`api:${tokenId}:min`, 600);
  if (!minute.allowed) {
    return { ok: false, retryAfterSec: minute.retryAfterSec || 60 };
  }
  return { ok: true };
}

export function hashRequestBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export async function checkIdempotency(
  db: Db,
  tokenId: string,
  key: string | null,
  requestHash: string,
): Promise<
  | { hit: false }
  | { hit: true; status: number; body: Record<string, unknown> }
  | { conflict: true }
> {
  if (!key) return { hit: false };
  const row = await db.query.idempotencyKeys.findFirst({
    where: and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.tokenId, tokenId)),
  });
  if (!row) {
    await db
      .insert(idempotencyKeys)
      .values({
        key,
        tokenId,
        requestHash,
        responseStatus: null,
        responseBody: null,
      })
      .onConflictDoNothing();
    return { hit: false };
  }
  if (row.requestHash !== requestHash) {
    return { conflict: true };
  }
  if (row.responseStatus != null && row.responseBody) {
    return {
      hit: true,
      status: row.responseStatus,
      body: row.responseBody as Record<string, unknown>,
    };
  }
  return { hit: false };
}

function jsonSafeRecord(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(body, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ) as Record<string, unknown>;
}

export async function storeIdempotency(
  db: Db,
  tokenId: string,
  key: string,
  requestHash: string,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  const safe = jsonSafeRecord(body);
  await db
    .insert(idempotencyKeys)
    .values({
      key,
      tokenId,
      requestHash,
      responseStatus: status,
      responseBody: safe,
    })
    .onConflictDoUpdate({
      target: [idempotencyKeys.key, idempotencyKeys.tokenId],
      set: {
        responseStatus: status,
        responseBody: safe,
      },
    });
}

export async function logApiRequest(
  db: Db,
  input: {
    tokenId: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    requestId: string;
    idempotencyKey?: string | null;
    idempotencyHit?: boolean;
  },
): Promise<void> {
  const { apiRequestLog } = await import('@nexus/db');
  await db.insert(apiRequestLog).values({
    id: newId(),
    tokenId: input.tokenId,
    method: input.method,
    path: input.path,
    status: input.status,
    durationMs: input.durationMs,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey ?? null,
    idempotencyHit: input.idempotencyHit ?? false,
  });
}
