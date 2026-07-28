import { NextResponse } from 'next/server';
import { getDb } from '@nexus/db';
import {
  createWorkItem,
  getProjectByKey,
  getWorkItemByKey,
  listWorkItems,
  transitionWorkItem,
  updateWorkItem,
  listProjectEvents,
  missingScopeForAction,
  listStages,
  launchRun,
} from '@nexus/core';
import {
  authenticateApiV1,
  enforceRateLimit,
  hashRequestBody,
  checkIdempotency,
  storeIdempotency,
  logApiRequest,
  problem,
} from '../../../../src/server/api-v1';
import { getOpenApiV1Document } from '../../../../src/server/openapi-v1';
import {
  mapCoreErrorToHttp,
  parseApiJsonBody,
  safeApiErrorResponse,
} from '../../../../src/server/api-v1-errors';
import { z } from 'zod';

const patchWorkItemBodySchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    complexity: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

export const dynamic = 'force-dynamic';

function serializeForJson(data: unknown): unknown {
  return JSON.parse(
    JSON.stringify(data, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}

function json(
  data: unknown,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(serializeForJson(data), { status, headers });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  return handle(req, await ctx.params);
}

export async function POST(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(req, await ctx.params);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(req, await ctx.params);
}

export async function PUT(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(req, await ctx.params);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(req, await ctx.params);
}

async function handle(req: Request, params: { path?: string[] }) {
  const start = Date.now();
  const requestId = crypto.randomUUID();
  const segments = params.path ?? [];
  const db = getDb();

  if (segments.length === 1 && segments[0] === 'openapi.json') {
    return json(getOpenApiV1Document(), 200, { 'x-request-id': requestId });
  }

  const auth = await authenticateApiV1(db, req);
  if (!auth.ok) {
    return json(auth.body, auth.status, { 'x-request-id': requestId });
  }

  const rate = await enforceRateLimit(auth.tokenId);
  if (!rate.ok) {
    return json(problem(429, 'Too Many Requests', 'Rate limit exceeded'), 429, {
      'x-request-id': requestId,
      'retry-after': String(rate.retryAfterSec),
    });
  }

  const path = `/api/v1/${segments.join('/')}`;
  const idempotencyKey = req.headers.get('idempotency-key');
  const bodyText =
    req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
  const requestHash = hashRequestBody(`${req.method}:${path}:${bodyText}`);

  if (idempotencyKey && (req.method === 'POST' || req.method === 'PUT')) {
    const idem = await checkIdempotency(db, auth.tokenId, idempotencyKey, requestHash);
    if ('conflict' in idem && idem.conflict) {
      return json(
        problem(422, 'Unprocessable Entity', 'Idempotency key reused with different body'),
        422,
        { 'x-request-id': requestId },
      );
    }
    if ('hit' in idem && idem.hit) {
      await logApiRequest(db, {
        tokenId: auth.tokenId,
        method: req.method,
        path,
        status: idem.status,
        durationMs: Date.now() - start,
        requestId,
        idempotencyKey,
        idempotencyHit: true,
      });
      return json(idem.body, idem.status, { 'x-request-id': requestId });
    }
  }

  let status = 404;
  let payload: unknown = problem(404, 'Not Found');

  try {
    if (segments[0] === 'projects' && segments.length === 1 && req.method === 'GET') {
      const missing = missingScopeForAction(auth.scopes, 'project.read');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, {
          missing_scope: missing,
        });
      } else {
        const projects = await db.query.projects.findMany({
          where: (p, { eq }) => eq(p.id, auth.projectId),
        });
        status = 200;
        payload = { projects: projects.map((p) => ({ id: p.id, key: p.key, name: p.name })) };
      }
    } else if (
      segments[0] === 'projects' &&
      segments.length === 2 &&
      req.method === 'GET'
    ) {
      const missing = missingScopeForAction(auth.scopes, 'project.read');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const projectKey = segments[1]!;
        const project = await getProjectByKey(auth.ctx, projectKey);
        if (!project.ok || project.value.id !== auth.projectId) {
          status = 404;
          payload = problem(404, 'Not Found', 'Project not found');
        } else {
          status = 200;
          payload = { id: project.value.id, key: project.value.key, name: project.value.name };
        }
      }
    } else if (
      segments[0] === 'projects' &&
      segments[2] === 'stages' &&
      segments.length === 3 &&
      req.method === 'GET'
    ) {
      const missing = missingScopeForAction(auth.scopes, 'project.read');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const projectKey = segments[1]!;
        const project = await getProjectByKey(auth.ctx, projectKey);
        if (!project.ok || project.value.id !== auth.projectId) {
          status = 404;
          payload = problem(404, 'Not Found', 'Project not found');
        } else {
          const stagesR = await listStages(auth.ctx, auth.projectId);
          status = 200;
          payload = {
            stages: stagesR.ok
              ? stagesR.value.map((s) => ({
                  id: s.id,
                  key: s.key,
                  name: s.name,
                  position: s.position,
                }))
              : [],
          };
        }
      }
    } else if (
      segments[0] === 'projects' &&
      segments[2] === 'work-items' &&
      segments.length === 3 &&
      req.method === 'GET'
    ) {
      const missing = missingScopeForAction(auth.scopes, 'work_item.read');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const projectKey = segments[1]!;
        const project = await getProjectByKey(auth.ctx, projectKey);
        if (!project.ok || project.value.id !== auth.projectId) {
          status = 404;
          payload = problem(404, 'Not Found');
        } else {
          const items = await listWorkItems(auth.ctx, project.value.id);
          const urlObj = new URL(req.url);
          const limit = Math.min(
            100,
            Math.max(1, Number.parseInt(urlObj.searchParams.get('limit') ?? '50', 10) || 50),
          );
          const offset = Math.max(
            0,
            Number.parseInt(urlObj.searchParams.get('offset') ?? '0', 10) || 0,
          );
          const all = items.ok ? items.value : [];
          status = 200;
          payload = {
            work_items: all.slice(offset, offset + limit),
            pagination: { limit, offset, total: all.length },
          };
        }
      }
    } else if (
      segments[0] === 'projects' &&
      segments[2] === 'work-items' &&
      segments.length === 3 &&
      req.method === 'POST'
    ) {
      const missing = missingScopeForAction(auth.scopes, 'work_item.create');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const projectKey = segments[1]!;
        const project = await getProjectByKey(auth.ctx, projectKey);
        const parsedBody = parseApiJsonBody(bodyText);
        if (!parsedBody.ok) {
          status = 400;
          payload = problem(400, 'Bad Request', 'Invalid JSON body', { request_id: requestId });
        } else if (!project.ok || project.value.id !== auth.projectId) {
          status = 404;
          payload = problem(404, 'Not Found');
        } else {
          const created = await createWorkItem(auth.ctx, {
            projectId: project.value.id,
            title: String(parsedBody.value.title ?? 'Untitled'),
            description:
              parsedBody.value.description !== undefined
                ? String(parsedBody.value.description)
                : undefined,
          });
          if (!created.ok) {
            status = mapCoreErrorToHttp(created.error);
            payload = problem(status, 'Error', created.error.message, { request_id: requestId });
          } else {
            status = 201;
            payload = created.value;
          }
        }
      }
    } else if (segments[0] === 'work-items' && segments.length === 2 && req.method === 'GET') {
      const missing = missingScopeForAction(auth.scopes, 'work_item.read');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const item = await getWorkItemByKey(auth.ctx, auth.projectId, segments[1]!);
        if (!item.ok || item.value.projectId !== auth.projectId) {
          status = 404;
          payload = problem(404, 'Not Found');
        } else {
          status = 200;
          payload = item.value;
        }
      }
    } else if (segments[0] === 'work-items' && segments.length === 2 && req.method === 'PATCH') {
      const missing = missingScopeForAction(auth.scopes, 'work_item.update');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const parsedBody = parseApiJsonBody(bodyText);
        if (!parsedBody.ok) {
          status = 400;
          payload = problem(400, 'Bad Request', 'Invalid JSON body', { request_id: requestId });
        } else {
          const parsed = patchWorkItemBodySchema.safeParse(parsedBody.value);
          if (!parsed.success) {
            status = 400;
            payload = problem(400, 'Bad Request', 'Invalid request body', {
              request_id: requestId,
            });
          } else {
            const item = await getWorkItemByKey(auth.ctx, auth.projectId, segments[1]!);
            if (!item.ok || item.value.projectId !== auth.projectId) {
              status = 404;
              payload = problem(404, 'Not Found');
            } else {
              const updated = await updateWorkItem(
                auth.ctx,
                item.value.id,
                {
                  title: parsed.data.title,
                  description: parsed.data.description,
                  complexity: parsed.data.complexity,
                },
                item.value.version,
              );
              if (!updated.ok) {
                status = mapCoreErrorToHttp(updated.error);
                payload = problem(status, 'Error', updated.error.message, {
                  request_id: requestId,
                });
              } else {
                status = 200;
                payload = updated.value;
              }
            }
          }
        }
      }
    } else if (
      segments[0] === 'work-items' &&
      segments[2] === 'transition' &&
      segments.length === 3 &&
      req.method === 'POST'
    ) {
      const missing = missingScopeForAction(auth.scopes, 'work_item.transition');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const body = JSON.parse(bodyText || '{}') as {
          to_stage?: string;
          reason_code?: string;
          note?: string;
        };
        const item = await getWorkItemByKey(auth.ctx, auth.projectId, segments[1]!);
        if (!item.ok || item.value.projectId !== auth.projectId) {
          status = 404;
          payload = problem(404, 'Not Found');
        } else {
          const stagesR = await listStages(auth.ctx, auth.projectId);
          const stage = stagesR.ok
            ? stagesR.value.find((s) => s.key === body.to_stage)
            : undefined;
          if (!stage) {
            status = 400;
            payload = problem(400, 'Bad Request', 'Unknown stage');
          } else {
            const result = await transitionWorkItem(
              auth.ctx,
              item.value.id,
              { toStageId: stage.id, reasonCode: body.reason_code, note: body.note },
              item.value.version,
            );
            if (!result.ok) {
              if (result.error.code === 'gate_blocked') {
                status = 409;
                payload = {
                  ...problem(409, 'Conflict', result.error.message),
                  blocking: result.error.details,
                };
              } else {
                status = 400;
                payload = problem(400, 'Bad Request', result.error.message);
              }
            } else {
              status = 200;
              payload = result.value;
            }
          }
        }
      }
    } else if (
      segments[0] === 'work-items' &&
      segments[2] === 'runs' &&
      segments.length === 3 &&
      req.method === 'POST'
    ) {
      const missing = missingScopeForAction(auth.scopes, 'run.launch');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const item = await getWorkItemByKey(auth.ctx, auth.projectId, segments[1]!);
        if (!item.ok || item.value.projectId !== auth.projectId) {
          status = 404;
          payload = problem(404, 'Not Found');
        } else {
          const launched = await launchRun(auth.ctx, { workItemId: item.value.id });
          if (!launched.ok) {
            status = mapCoreErrorToHttp(launched.error);
            payload = problem(status, 'Error', launched.error.message, { request_id: requestId });
          } else {
            status = 201;
            payload = { run: launched.value };
          }
        }
      }
    } else if (
      segments[0] === 'work-items' &&
      segments[2] === 'events' &&
      segments.length === 3 &&
      req.method === 'GET'
    ) {
      const missing = missingScopeForAction(auth.scopes, 'work_item.read');
      if (missing) {
        status = 403;
        payload = problem(403, 'Forbidden', `Missing scope: ${missing}`, { missing_scope: missing });
      } else {
        const item = await getWorkItemByKey(auth.ctx, auth.projectId, segments[1]!);
        if (!item.ok || item.value.projectId !== auth.projectId) {
          status = 404;
          payload = problem(404, 'Not Found');
        } else {
          const eventsR = await listProjectEvents(auth.ctx, item.value.projectId, {
            subjectId: item.value.id,
            limit: 50,
          });
          status = 200;
          payload = { events: eventsR.ok ? eventsR.value : [] };
        }
      }
    }
  } catch (e) {
    console.error('api_v1_unhandled', requestId, e);
    const safe = safeApiErrorResponse(requestId, e);
    status = safe.status;
    payload = problem(safe.status, safe.status >= 500 ? 'Internal Server Error' : 'Error', safe.detail, {
      request_id: requestId,
    });
  }

  if (
    idempotencyKey &&
    (req.method === 'POST' || req.method === 'PUT') &&
    status < 500 &&
    typeof payload === 'object' &&
    payload
  ) {
    await storeIdempotency(
      db,
      auth.tokenId,
      idempotencyKey,
      requestHash,
      status,
      payload as Record<string, unknown>,
    );
  }

  await logApiRequest(db, {
    tokenId: auth.tokenId,
    method: req.method,
    path,
    status,
    durationMs: Date.now() - start,
    requestId,
    idempotencyKey,
  });

  return json(payload, status, { 'x-request-id': requestId });
}
