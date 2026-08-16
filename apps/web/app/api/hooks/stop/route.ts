import { NextResponse } from 'next/server';
import { HOOK_COST_PENDING_SOURCE } from '@nexus/core';
import { cursorStopHookEvents, getDb, newId } from '@nexus/db';
import {
  authorizeStopHookRequest,
  calculateHookDurationMs,
  extractBranchFromPayload,
  extractRepoFromPayload,
  extractWorkspaceRoot,
  parseHookTimestamp,
} from '../../../../src/server/stop-hook';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 256 * 1024;

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function POST(req: Request) {
  if (!authorizeStopHookRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const receivedAt = new Date();
  const rawText = await req.text();
  if (rawText.length > MAX_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = rawText.trim() ? JSON.parse(rawText) : {};
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const payload = asObject(parsed) ?? { _value: parsed };
  const workspaceRoots = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots
    : [];
  const modelParams = Array.isArray(payload.model_params)
    ? (payload.model_params as Array<{ id: string; value: string }>)
    : null;

  const userEmail = asString(payload.user_email);
  const startedAt = parseHookTimestamp(payload.started_at);
  const finishedAt = parseHookTimestamp(payload.finished_at) ?? receivedAt;
  const durationMs = calculateHookDurationMs(startedAt, finishedAt);

  const id = newId();
  await getDb()
    .insert(cursorStopHookEvents)
    .values({
      id,
      conversationId: asString(payload.conversation_id),
      generationId: asString(payload.generation_id),
      model: asString(payload.model),
      modelId: asString(payload.model_id),
      hookEventName: asString(payload.hook_event_name) ?? 'stop',
      cursorVersion: asString(payload.cursor_version),
      userEmail,
      transcriptPath: asString(payload.transcript_path),
      status: asString(payload.status),
      loopCount: asInt(payload.loop_count),
      workspaceRoots,
      workspaceRoot: extractWorkspaceRoot(payload),
      repo: extractRepoFromPayload(payload),
      gitBranch: extractBranchFromPayload(payload),
      modelParams,
      chargedCents: null,
      costSource: HOOK_COST_PENDING_SOURCE,
      costLookupError: null,
      usageEvent: null,
      costLookedUpAt: null,
      payload,
      startedAt,
      finishedAt,
      durationMs,
      receivedAt,
    });

  return NextResponse.json({
    ok: true,
    id,
    chargedCents: null,
    costSource: HOOK_COST_PENDING_SOURCE,
    costLookupError: null,
    startedAt: startedAt?.toISOString() ?? null,
    finishedAt: finishedAt.toISOString(),
    durationMs,
  });
}
