import { EmptyState, PageHeader, Panel } from '@nexus/ui';
import Link from 'next/link';
import {
  formatHookCostUsd,
  formatRelativeTime,
} from '../../../src/lib/monitoring-format';
import { TeamApiKeysPanel } from '../../../src/components/TeamApiKeysPanel';
import {
  HOOK_NO_REPO_GROUP,
  loadHookSignalsTree,
  projectsFromHookSummaries,
  summarizeHookRepos,
} from '../../../src/server/hook-signals';
import { listCursorOrganisationViews } from '../../../src/server/cursor-organisations';

export const dynamic = 'force-dynamic';

export default async function MonitoringPage() {
  let error: string | null = null;
  let projects: ReturnType<typeof projectsFromHookSummaries> = [];
  let hookEventCount = 0;
  let truncated = false;
  let organisations: Awaited<ReturnType<typeof listCursorOrganisationViews>> =
    [];

  try {
    const hookTree = await loadHookSignalsTree();
    hookEventCount = hookTree.totalEvents;
    truncated = hookTree.truncated;
    projects = projectsFromHookSummaries(summarizeHookRepos(hookTree));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  try {
    organisations = await listCursorOrganisationViews();
  } catch {
    // Team key management is optional on this page; hook data still renders.
  }

  const totalCharged = projects.reduce(
    (sum, p) => (p.totalChargedCents != null ? sum + p.totalChargedCents : sum),
    0,
  );
  const anyCost = projects.some((p) => p.totalChargedCents != null);

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Monitoring"
        subtitle="Every repository is a project. Local stop-hook turns land immediately; charged cost is filled from the Team usage API about five minutes later."
        meta={
          projects.length > 0
            ? `${projects.length} project${projects.length === 1 ? '' : 's'}${hookEventCount > 0 ? ` · ${hookEventCount} local request${hookEventCount === 1 ? '' : 's'}` : ''}${anyCost ? ` · ${formatHookCostUsd(totalCharged)} charged` : ''}`
            : undefined
        }
        actions={
          <div className="flex items-center gap-3">
            <a
              href="#team-api-keys"
              className="text-xs text-accent hover:underline"
            >
              Team API keys
            </a>
            <Link
              href="/hooks/setup"
              className="text-xs text-accent hover:underline"
            >
              Copy stop hook
            </Link>
          </div>
        }
      />

      {error ? (
        <p className="text-sm text-danger-fg" role="alert">
          {error}
        </p>
      ) : null}

      <TeamApiKeysPanel organisations={organisations} />

      {projects.length === 0 && !error ? (
        <Panel>
          <EmptyState
            title="No local requests yet"
            description="Install the Cursor stop hook to record turn metadata here, grouped by the repository each request worked on."
          />
        </Panel>
      ) : null}

      {projects.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.repo}
              href={`/monitoring/${encodeURIComponent(project.repo)}`}
              className="group block rounded-md border border-border bg-surface p-3 transition-colors hover:bg-[var(--nx-hover)]"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-sm font-medium text-fg group-hover:underline">
                  {project.repo === HOOK_NO_REPO_GROUP
                    ? 'No repository'
                    : project.repo}
                </span>
                <span className="shrink-0 text-xs text-fg-subtle">
                  {project.latestCreatedAt
                    ? formatRelativeTime(project.latestCreatedAt)
                    : '—'}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-xl font-medium tabular-nums text-fg">
                  {formatHookCostUsd(project.totalChargedCents)}
                </span>
                <span className="text-xs text-fg-subtle">charged</span>
              </div>
              <div className="mt-1 text-xs text-fg-muted">
                {project.conversationCount} conversation
                {project.conversationCount === 1 ? '' : 's'}
                {' · '}
                {project.eventCount} turn
                {project.eventCount === 1 ? '' : 's'}
              </div>
            </Link>
          ))}
        </div>
      ) : null}

      {truncated ? (
        <p className="text-xs text-fg-subtle">
          Local request list truncated — showing the most recent hook events.
        </p>
      ) : null}
    </div>
  );
}
