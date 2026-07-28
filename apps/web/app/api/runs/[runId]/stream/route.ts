import { NextResponse } from 'next/server';
import { getDb, runs } from '@nexus/db';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Best-effort SSE proxy to Cursor run stream while a user watches.
 * Any failure (including 410 stream_expired) degrades silently — clients
 * should fall back to polling. No state is derived solely from this stream.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const db = getDb();
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run?.providerAgentId || !run.providerRunId) {
    return NextResponse.json(
      { ok: false, error: 'no_provider_stream', fallback: 'poll' },
      { status: 404 },
    );
  }

  const apiKey =
    process.env.CURSOR_API_KEY ?? process.env.CURSOR_SERVICE_ACCOUNT_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'no_api_key', fallback: 'poll' },
      { status: 503 },
    );
  }

  const url = `https://api.cursor.com/v1/agents/${encodeURIComponent(run.providerAgentId)}/runs/${encodeURIComponent(run.providerRunId)}/stream`;
  try {
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        Accept: 'text/event-stream',
      },
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        {
          ok: false,
          error: 'stream_unavailable',
          status: upstream.status,
          fallback: 'poll',
        },
        { status: 502 },
      );
    }
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'stream_error', fallback: 'poll' },
      { status: 502 },
    );
  }
}
