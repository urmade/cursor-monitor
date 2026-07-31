import { Button, PageHeader } from '@nexus/ui';
import Link from 'next/link';
import { HookSignalsDashboard } from '../../../src/components/HookSignalsDashboard';
import { loadHookSignalsTree } from '../../../src/server/hook-signals';

export const dynamic = 'force-dynamic';

export default async function HooksSignalsPage() {
  let tree;
  let error: string | null = null;
  try {
    tree = await loadHookSignalsTree();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    tree = { users: [], totalEvents: 0, truncated: false };
  }

  return (
    <div className="space-y-4 p-4 max-w-4xl">
      <PageHeader
        title="Hook signals"
        subtitle="Stop-hook telemetry grouped by user → repository → conversation. Each turn shows the full stored log entry, including payload and chargedCents from Cursor usage events when available."
        meta="Hooks"
        actions={
          <Button asChild size="sm" variant="secondary">
            <Link href="/hooks/setup">Copy stop hook</Link>
          </Button>
        }
      />

      {error ? (
        <p className="text-sm text-danger-fg" role="alert">
          Failed to load signals: {error}
        </p>
      ) : null}

      <HookSignalsDashboard tree={tree} />
    </div>
  );
}
