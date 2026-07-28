import { NextResponse } from 'next/server';
import { handleMcpHttpRequest } from '@nexus/mcp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  return handleMcpHttpRequest(req);
}

export async function POST(req: Request) {
  return handleMcpHttpRequest(req);
}

export async function DELETE() {
  return NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
    { status: 405 },
  );
}
