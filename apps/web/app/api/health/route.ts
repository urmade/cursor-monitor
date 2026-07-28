import { NextResponse } from 'next/server';
import { getMigrationVersion, pingDb, getDb, mcpCallLog } from '@nexus/db';
import { queueDepth, readLastCronTick } from '@nexus/jobs';
import { readLastReconciliation } from '@nexus/core';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET() {
  let dbOk = false;
  let migrationVersion: string | null = null;
  let lastCronTick: string | null = null;
  let queue: {
    pending: number;
    running: number;
    oldestPendingAt: string | null;
  } | null = null;
  let mcp: { callsLastMinute: number } | null = null;
  let attention: { lastReconcileAt: string | null; drift: number | null } | null =
    null;

  try {
    dbOk = await pingDb();
  } catch {
    dbOk = false;
  }

  try {
    migrationVersion = await getMigrationVersion();
  } catch {
    migrationVersion = null;
  }

  try {
    lastCronTick = await readLastCronTick();
  } catch {
    lastCronTick = null;
  }

  let webhookPending: number | null = null;
  if (dbOk) {
    try {
      const depth = await queueDepth(getDb());
      queue = {
        pending: depth.pending,
        running: depth.running,
        oldestPendingAt: depth.oldestPendingAt
          ? new Date(depth.oldestPendingAt).toISOString()
          : null,
      };
    } catch {
      queue = null;
    }

    try {
      const rows = await getDb().execute(sql`
        select count(*)::int as c from mcp_call_log
        where created_at > now() - interval '1 minute'
      `);
      const arr = rows as unknown as Array<{ c: number }>;
      mcp = { callsLastMinute: Number(arr[0]?.c ?? 0) };
    } catch {
      mcp = { callsLastMinute: 0 };
    }

    try {
      const recon = await readLastReconciliation();
      attention = {
        lastReconcileAt: recon.at,
        drift: recon.drift,
      };
    } catch {
      attention = null;
    }

    webhookPending = await loadWebhookPending();
  }

  return NextResponse.json({
    ok: true,
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    db: dbOk ? 'ok' : 'unavailable',
    migrationVersion,
    lastCronTick,
    queue,
    mcp,
    attention,
    webhooks: { pendingDeliveries: webhookPending },
  });
}

async function loadWebhookPending(): Promise<number | null> {
  try {
    const org = await getDb().query.orgs.findFirst();
    if (!org) return null;
    const { createContext, countPendingDeliveries, createFlagReader } = await import('@nexus/core');
    const ctx = createContext({
      db: getDb(),
      orgId: org.id,
      actor: { kind: 'system', reason: 'health' },
      flags: createFlagReader(getDb()),
    });
    return await countPendingDeliveries(ctx);
  } catch {
    return null;
  }
}

void mcpCallLog;
