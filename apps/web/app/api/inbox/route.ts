import { NextRequest, NextResponse } from 'next/server';
import type { AttentionKind } from '@nexus/contracts';
import { listInbox } from '@nexus/core';
import { optionalSession } from '../../../src/server/session';

export const dynamic = 'force-dynamic';

const KINDS: AttentionKind[] = [
  'blocking_question',
  'pending_approval',
  'budget_block',
  'run_failed',
  'run_completed_no_report',
  'loop_escalation',
  'external_block',
];

export async function GET(req: NextRequest) {
  const session = await optionalSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const params = req.nextUrl.searchParams;
  const projectIds = params.getAll('projectId').filter(Boolean);
  const kindsParam = params.getAll('kind').filter(Boolean);
  const kinds = kindsParam.filter((k): k is AttentionKind =>
    KINDS.includes(k as AttentionKind),
  );
  const page = await listInbox(session.ctx, {
    limit: 200,
    ...(projectIds.length > 0 ? { projectIds } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
  });
  if (!page.ok) {
    return NextResponse.json({ error: page.error.message }, { status: 400 });
  }
  return NextResponse.json({
    groups: page.value.groups,
    totalOpen: page.value.totalOpen,
  });
}
