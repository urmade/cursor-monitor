import { NextResponse } from 'next/server';
import { getMigrationVersion, pingDb } from '@nexus/db';
import { readLastCronTick } from '@nexus/jobs';

export const dynamic = 'force-dynamic';

export async function GET() {
  let dbOk = false;
  let migrationVersion: string | null = null;
  let lastCronTick: string | null = null;

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

  return NextResponse.json({
    ok: true,
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    db: dbOk ? 'ok' : 'unavailable',
    migrationVersion,
    lastCronTick,
  });
}
