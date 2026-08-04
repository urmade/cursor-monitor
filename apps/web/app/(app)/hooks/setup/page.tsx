import { Button, PageHeader } from '@nexus/ui';
import { headers } from 'next/headers';
import Link from 'next/link';
import { StopHookCopyPanel } from '../../../../src/components/StopHookCopyPanel';
import {
  loadHookIngestStatus,
  type HookIngestStatus,
} from '../../../../src/server/hook-signals';
import {
  buildStopHookArtifact,
  readProtectionBypass,
  resolvePublicBaseUrlDetailed,
} from '../../../../src/server/stop-hook';

export const dynamic = 'force-dynamic';

export default async function HooksSetupPage() {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const req = new Request(`${proto}://${host ?? 'localhost:3000'}/hooks/setup`, {
    headers: h,
  });

  const target = resolvePublicBaseUrlDetailed(req);
  const artifact = buildStopHookArtifact({
    baseUrl: target.baseUrl,
    bypass: readProtectionBypass(),
  });

  let ingest: HookIngestStatus | null = null;
  let ingestError: string | null = null;
  try {
    ingest = await loadHookIngestStatus();
  } catch (err) {
    ingestError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="space-y-4 p-4 max-w-3xl">
      <PageHeader
        title="Install stop hook"
        subtitle="Team Hooks for the local IDE; project .cursor/hooks for Cloud Agents (cloud VMs do not sync ~/.cursor/managed/team_*)."
        meta="Hooks / Setup"
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link href="/monitoring">← Monitoring</Link>
          </Button>
        }
      />
      <StopHookCopyPanel
        hooksJson={artifact.hooksJson}
        projectHooksJson={artifact.projectHooksJson}
        script={artifact.script}
        scriptFilename={artifact.scriptFilename}
        endpoint={artifact.endpoint}
        bypassConfigured={artifact.bypassConfigured}
        installSteps={artifact.installSteps}
        logFile={artifact.logFile}
        environment={target.environment}
        endpointStable={target.stable}
        ingest={ingest}
        ingestError={ingestError}
      />
    </div>
  );
}
