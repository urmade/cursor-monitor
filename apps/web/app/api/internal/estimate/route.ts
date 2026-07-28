import { NextResponse } from 'next/server';
import { estimateForNewItem, getProjectByKey } from '@nexus/core';
import { requireSession } from '../../../../src/server/session';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectKey = url.searchParams.get('projectKey');
  const complexity = url.searchParams.get('complexity') as
    | 'low'
    | 'medium'
    | 'high'
    | null;
  const labels = (url.searchParams.get('labels') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!projectKey || !complexity) {
    return NextResponse.json({ error: 'projectKey and complexity required' }, { status: 400 });
  }

  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const est = await estimateForNewItem(ctx, {
    projectId: project.value.id,
    complexity,
    labelKeys: labels,
  });
  if (!est.ok) {
    return NextResponse.json({ error: est.error.message }, { status: 400 });
  }
  return NextResponse.json({ estimate: est.value });
}
