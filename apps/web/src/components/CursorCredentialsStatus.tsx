import Link from 'next/link';
import { Button } from '@nexus/ui';

export function CursorCredentialsStatus({
  connectedCount,
  source,
  identityLabel,
}: {
  connectedCount: number;
  source: 'user_cookie' | 'env' | 'none';
  identityLabel: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2">
      <div className="min-w-0 text-xs text-fg-muted">
        {connectedCount > 0 ? (
          <span>
            Connected to{' '}
            <strong className="text-fg">
              {connectedCount} organisation{connectedCount === 1 ? '' : 's'}
            </strong>
            {identityLabel ? ` · ${identityLabel}` : ''}
          </span>
        ) : source === 'env' ? (
          <span>
            Using env / service-account key
            {identityLabel ? ` (${identityLabel})` : ''}. Connect personal
            organisation keys in Settings for multi-org Monitoring.
          </span>
        ) : (
          <span>
            No Cursor organisations connected yet. Add API keys and org ids in
            Settings to load Monitoring.
          </span>
        )}
      </div>
      <Button asChild size="sm" variant="secondary">
        <Link href="/settings/organisations">
          {connectedCount > 0 ? 'Manage organisations' : 'Connect organisations'}
        </Link>
      </Button>
    </div>
  );
}
