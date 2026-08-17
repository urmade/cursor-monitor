import { EmptyState, PageHeader, Panel } from '@nexus/ui';
import Link from 'next/link';
import { MonitoringProjectCard } from '../../../src/components/MonitoringProjectCard';
import { MonitoringHiddenRepos } from '../../../src/components/MonitoringRepoManage';
import { TeamApiKeysPanel } from '../../../src/components/TeamApiKeysPanel';
import { formatHookCostUsd } from '../../../src/lib/monitoring-format';
import {
  HOOK_NO_REPO_GROUP,
  loadHookSignalsTree,
  projectsFromHookSummaries,
  summarizeHookRepos,
} from '../../../src/server/hook-signals';
import { listCursorOrganisationViews } from '../../../src/server/cursor-organisations';
import {
  applyMonitoringRepoPrefs,
  loadMonitoringRepoPrefs,
} from '../../../src/server/monitoring-repo-prefs';
import { optionalSession } from '../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function MonitoringPage() {
  let error: string | null = null;
  let projects: ReturnType<typeof applyMonitoringRepoPrefs> = [];
  let hiddenProjects: ReturnType<typeof applyMonitoringRepoPrefs> = [];
  let hookEventCount = 0;
  let truncated = false;
  let manageEnabled = false;
  let organisations: Awaited<ReturnType<typeof listCursorOrganisationViews>> =
    [];

  try {
    const session = await optionalSession();
    manageEnabled = Boolean(session);
    const [hookTree, prefs] = await Promise.all([
      loadHookSignalsTree(),
      session
        ? loadMonitoringRepoPrefs(session.orgId)
        : Promise.resolve([]),
    ]);
    hookEventCount = hookTree.totalEvents;
    truncated = hookTree.truncated;
    const raw = projectsFromHookSummaries(summarizeHookRepos(hookTree));
    projects = applyMonitoringRepoPrefs(raw, prefs);
    hiddenProjects = applyMonitoringRepoPrefs(raw, prefs, {
      includeHidden: true,
    }).filter((p) => p.hidden);
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

  const mergeTargetsFor = (repo: string) =>
    projects
      .filter((p) => p.repo !== repo && p.repo !== HOOK_NO_REPO_GROUP)
      .map((p) => ({ repo: p.repo, displayName: p.displayName }));

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Monitoring"
        subtitle="Every repository is a project. Local stop-hook turns land immediately; charged cost is filled from the Team usage API about five minutes later. Rename, hide, or merge related repositories from each card’s menu."
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
            <MonitoringProjectCard
              key={project.repo}
              project={project}
              mergeTargets={mergeTargetsFor(project.repo)}
              manageEnabled={manageEnabled}
            />
          ))}
        </div>
      ) : null}

      {manageEnabled ? (
        <MonitoringHiddenRepos
          projects={hiddenProjects.map((p) => ({
            repo: p.repo,
            displayName: p.displayName,
          }))}
        />
      ) : null}

      {truncated ? (
        <p className="text-xs text-fg-subtle">
          Local request list truncated — showing the most recent hook events.
        </p>
      ) : null}
    </div>
  );
}
