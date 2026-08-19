import { getDatabase, newId } from '@cursor-monitor/db';
import { NextResponse } from 'next/server';
import {
  authorizeHookRequest,
  MAX_HOOK_BYTES,
  parseHookEvent,
} from '@/src/server/hook-ingest';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!authorizeHookRequest(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_HOOK_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_HOOK_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }
  let value: unknown;
  try {
    value = body.trim() ? JSON.parse(body) : {};
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const receivedAt = new Date();
  const event = parseHookEvent(value, receivedAt);
  const id = newId();
  const insertedId = await getDatabase().hooks.insert({
    id,
    ...event,
    receivedAt,
  });

  return NextResponse.json({
    ok: true,
    id: insertedId,
    duplicate: insertedId === null,
    repository: event.repositoryKey,
    conversation: event.conversationKey,
    occurredAt: event.occurredAt.toISOString(),
  });
}
