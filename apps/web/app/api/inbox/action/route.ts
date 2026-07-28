import { NextResponse } from 'next/server';
import { executeAction } from '@nexus/core';
import { requireSession } from '../../../../src/server/session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { ctx } = await requireSession();
  const body = (await req.json()) as {
    attentionItemId?: string;
    action?: string;
    payload?: Record<string, unknown>;
  };
  const attentionItemId = String(body.attentionItemId ?? '');
  const action = String(body.action ?? '');
  if (!attentionItemId || !action) {
    return NextResponse.json({ ok: false, error: 'Missing fields' }, { status: 400 });
  }
  const result = await executeAction(ctx, {
    attentionItemId,
    action,
    payload: body.payload,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, value: result.value });
}
