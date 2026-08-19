import { getHookScript } from '@/src/server/hook-scripts';
import { currentAdmin } from '@/src/server/identity';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ platform: string; script: string }> },
) {
  if (!(await currentAdmin())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { platform, script } = await context.params;
  const artifact = getHookScript(platform, script);
  if (!artifact) {
    return Response.json({ error: 'unsupported_hook_script' }, { status: 404 });
  }
  if (!artifact.ready) {
    return Response.json(
      { error: 'hook_token_not_configured' },
      { status: 503 },
    );
  }
  return new Response(artifact.content, {
    headers: {
      'Content-Type': artifact.contentType,
      'Content-Disposition': `attachment; filename="${artifact.filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
