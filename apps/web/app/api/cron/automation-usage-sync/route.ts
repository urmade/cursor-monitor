import { NextResponse } from 'next/server';
import {
  createContext,
  createFlagReader,
  silentLogger,
  syncAutomationUsageEvents,
  validateFdeAdmAutomationUsageSync,
} from '@nexus/core';
import { getDb } from '@nexus/db';
import { enqueueJob } from '@nexus/jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${secret}`) return true;

  const header = req.headers.get('x-cron-secret');
  if (header === secret) return true;

  return false;
}

/**
 * Manual / validation entry for automation usage sync.
 *
 * - Default: sync all Cursor organisations (6-minute lookback).
 * - `?validate=fde-adm`: sync only FDE/ADM labels with a 1h window and
 *   require both organisations to succeed against filtered-usage-events.
 * - `?enqueue=1`: enqueue the cadence job instead of running inline.
 */
async function handle(req: Request) {
  if (!authorizeCron(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const validate = url.searchParams.get('validate');
  const enqueue = url.searchParams.get('enqueue') === '1';
  const lookbackRaw = url.searchParams.get('lookbackMs');
  const lookbackMs = lookbackRaw ? Number(lookbackRaw) : undefined;

  if (enqueue) {
    const db = getDb();
    const job = await enqueueJob(db, {
      kind: 'sync_automation_usage_events',
      payload: {
        validateFdeAdm: validate === 'fde-adm',
        ...(lookbackMs && Number.isFinite(lookbackMs) ? { lookbackMs } : {}),
      },
      dedupeKey: `sync_automation_usage_events:manual:${Date.now()}`,
      priority: 9,
    });
    return NextResponse.json({ ok: true, enqueued: job.id });
  }

  const db = getDb();
  const org = await db.query.orgs.findFirst();
  if (!org) {
    return NextResponse.json(
      { ok: false, error: 'No Nexus organisation' },
      { status: 500 },
    );
  }

  const ctx = createContext({
    db,
    orgId: org.id,
    actor: { kind: 'system', reason: 'automation_usage_sync_api' },
    flags: createFlagReader(db),
    logger: silentLogger,
  });

  const summary =
    validate === 'fde-adm'
      ? await validateFdeAdmAutomationUsageSync(ctx, {
          ...(lookbackMs && Number.isFinite(lookbackMs) ? { lookbackMs } : {}),
        })
      : await syncAutomationUsageEvents(ctx, {
          lookbackMs:
            lookbackMs && Number.isFinite(lookbackMs) ? lookbackMs : undefined,
        });

  const status =
    validate === 'fde-adm' && summary.validation && !summary.validation.ok
      ? 422
      : 200;

  return NextResponse.json({ ok: status === 200, summary }, { status });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
