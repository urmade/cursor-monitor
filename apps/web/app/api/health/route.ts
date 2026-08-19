import { getDatabase } from '@cursor-monitor/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const database = await getDatabase().ping();
  return Response.json(
    {
      ok: database,
      service: 'cursor-monitor',
      database,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    },
    { status: database ? 200 : 503 },
  );
}
