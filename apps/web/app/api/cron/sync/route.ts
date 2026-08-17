import { timingSafeEqual } from 'node:crypto';
import { syncTeamUsage } from '@cursor-monitor/core';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const supplied = bearer || request.headers.get('x-cron-secret')?.trim() || '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function handle(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json(
      { error: 'cron_not_configured' },
      { status: 503 },
    );
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await syncTeamUsage();
  return NextResponse.json(result, {
    status: result.status === 'failed' ? 502 : 200,
  });
}

export const GET = handle;
export const POST = handle;
