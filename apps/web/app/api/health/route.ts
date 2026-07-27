import { NextResponse } from 'next/server';
import { getMigrationVersion, pingDb } from '@nexus/db';
import { queueDepth, readLastCronTick } from '@nexus/jobs';
import { getDb } from '@nexus/db';

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
  }

  return NextResponse.json({
    ok: true,
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    db: dbOk ? 'ok' : 'unavailable',
    migrationVersion,
    lastCronTick,
    queue,
  });
}
