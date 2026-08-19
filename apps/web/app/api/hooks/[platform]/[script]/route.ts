import {
  hookScriptDownloadHeaders,
  resolveHookScriptDownload,
} from '@/src/server/hook-scripts';
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
  const resolved = resolveHookScriptDownload(platform, script);
  if (resolved.status === 'unsupported') {
    return Response.json({ error: 'unsupported_hook_script' }, { status: 404 });
  }
  if (resolved.status === 'not_ready') {
    return Response.json(
      { error: 'hook_token_not_configured' },
      { status: 503 },
    );
  }
  return new Response(resolved.artifact.content, {
    headers: hookScriptDownloadHeaders(resolved.artifact),
  });
}
