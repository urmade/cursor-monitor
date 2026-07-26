import { NextResponse } from 'next/server';
import { runCronTick } from '@nexus/jobs';

export const dynamic = 'force-dynamic';

function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${secret}`) return true;

  const header = req.headers.get('x-cron-secret');
  if (header === secret) return true;

  return false;
}

async function handle(req: Request) {
  if (!authorizeCron(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await runCronTick();
  return NextResponse.json(result);
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
