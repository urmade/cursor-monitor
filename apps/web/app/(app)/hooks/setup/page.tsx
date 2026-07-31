import { Button, PageHeader } from '@nexus/ui';
import { headers } from 'next/headers';
import Link from 'next/link';
import { StopHookCopyPanel } from '../../../../src/components/StopHookCopyPanel';
import {
  buildStopHookArtifact,
  readProtectionBypass,
  resolvePublicBaseUrl,
} from '../../../../src/server/stop-hook';

export const dynamic = 'force-dynamic';

export default async function HooksSetupPage() {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const req = new Request(`${proto}://${host ?? 'localhost:3000'}/hooks/setup`, {
    headers: h,
  });

  const artifact = buildStopHookArtifact({
    baseUrl: resolvePublicBaseUrl(req),
    bypass: readProtectionBypass(),
  });

  return (
    <div className="space-y-4 p-4 max-w-3xl">
      <PageHeader
        title="Install stop hook"
        subtitle="Pure bash + curl + git (macOS native, no language runtimes). The Vercel protection bypass from this deployment is embedded so any project can POST."
        meta="Hooks / Setup"
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link href="/hooks">← Signals</Link>
          </Button>
        }
      />
      <StopHookCopyPanel
        hooksJson={artifact.hooksJson}
        script={artifact.script}
        scriptFilename={artifact.scriptFilename}
        endpoint={artifact.endpoint}
        bypassConfigured={artifact.bypassConfigured}
        installSteps={artifact.installSteps}
      />
    </div>
  );
}
