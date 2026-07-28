#!/usr/bin/env npx tsx
/**
 * Example: create a work item via API v1 (requires NEXUS_API_URL and NEXUS_API_TOKEN).
 *
 * Local:
 *   DB_POSTGRES_URL=... pnpm db:exec-migrations && pnpm db:seed -- --demo
 *   NEXUS_API_TOKEN=$(npx tsx examples/mint-api-token.ts)
 *   pnpm --filter @nexus/web build && PORT=3001 pnpm --filter @nexus/web start
 *   NEXUS_API_URL=http://127.0.0.1:3001 NEXUS_API_TOKEN=... npx tsx examples/api-drive-ticket.ts
 */
const base = process.env.NEXUS_API_URL ?? 'http://127.0.0.1:3001';
const token = process.env.NEXUS_API_TOKEN;
const projectKey = process.env.NEXUS_PROJECT_KEY ?? 'ALPHA';

if (!token) {
  console.error('Set NEXUS_API_TOKEN');
  process.exit(1);
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  console.log('POST /projects/' + projectKey + '/work-items');
  const created = await api(`/projects/${projectKey}/work-items`, {
    method: 'POST',
    body: JSON.stringify({ title: 'API-driven ticket', description: 'From examples/api-drive-ticket.ts' }),
    headers: { 'idempotency-key': `demo-${Date.now()}` },
  });
  console.log('created', { key: created.key, stageId: created.currentStageId });

  const itemKey = created.key as string;
  console.log('PATCH /work-items/' + itemKey);
  await api(`/work-items/${itemKey}`, {
    method: 'PATCH',
    body: JSON.stringify({ complexity: 'medium' }),
  });
  console.log('complexity set to medium');

  const stagesRes = await api(`/projects/${projectKey}/stages`);
  const stages = (stagesRes.stages as { key: string; position: number }[]).sort(
    (a, b) => a.position - b.position,
  );
  const stageKeys = stages.map((s) => s.key);
  const deployKey = 'deploy';
  console.log('pipeline stages', stageKeys.join(' → '));

  let item = await api(`/work-items/${itemKey}`);
  const stageById = new Map(
    (stagesRes.stages as { id: string; key: string }[]).map((s) => [s.id, s.key]),
  );

  while (true) {
    const currentKey = stageById.get(item.currentStageId as string) ?? 'unknown';
    if (currentKey === deployKey) break;
    const idx = stageKeys.indexOf(currentKey);
    const nextKey = idx >= 0 && idx < stageKeys.length - 1 ? stageKeys[idx + 1] : null;
    if (!nextKey) break;
    console.log(`POST /work-items/${itemKey}/transition → ${nextKey}`);
    item = await api(`/work-items/${itemKey}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to_stage: nextKey }),
    });
  }

  item = await api(`/work-items/${itemKey}`);
  const finalStageKey = stageById.get(item.currentStageId as string);
  console.log('final state', {
    key: item.key,
    stage: finalStageKey,
    complexity: item.complexity,
    version: item.version,
  });
  if (finalStageKey !== deployKey) {
    throw new Error(`Expected deploy stage, got ${finalStageKey}`);
  }
  console.log('journey complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
