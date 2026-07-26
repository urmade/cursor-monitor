import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * MCP HTTP stub — Phase 2 fills tools and auth.
 * Kept so the route and deployment path survive Phase 0 teardown.
 */

export async function GET() {
  return NextResponse.json({
    ok: true,
    transport: 'streamable-http',
    stateless: true,
    tools: [],
    note: 'Phase 0 spike tools removed. Phase 2 will register the product MCP contract.',
  });
}

export async function POST() {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: 'MCP tools not registered yet (post Phase 0 teardown)',
      },
      id: null,
    },
    { status: 501 },
  );
}
