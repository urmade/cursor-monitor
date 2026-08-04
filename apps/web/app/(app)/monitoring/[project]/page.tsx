import { EmptyState, PageHeader, Panel } from '@nexus/ui';
import Link from 'next/link';
import { ProjectConversationsClient } from '../../../../src/components/ProjectConversationsClient';
import {
  formatHookCostUsd,
  parseConversationGroupSort,
} from '../../../../src/lib/monitoring-format';
import {
  HOOK_NO_REPO_GROUP,
  loadHookSignalsForRepo,
  loadKnownHookMonitoringRepos,
} from '../../../../src/server/hook-signals';
import { normalizeRepoLabel } from '../../../../src/server/cursor';

export const dynamic = 'force-dynamic';

function projectHref(project: string): string {
  return `/monitoring/${encodeURIComponent(project)}`;
}

/** Canonical project key: lowercased repo label, or the no-repo sentinel. */
function canonicalProject(project: string): string {
  return project === HOOK_NO_REPO_GROUP ? project : normalizeRepoLabel(project);
}

export default async function ProjectMonitoringPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { project: rawProject } = await params;
  const project = canonicalProject(decodeURIComponent(rawProject));
  const sp = await searchParams;
  const sort = parseConversationGroupSort(sp.sort);

  let localRequests = null;
  let hookError: string | null = null;
  let knownRepos: string[] = [];
  try {
    localRequests = await loadHookSignalsForRepo(project);
    if (project === HOOK_NO_REPO_GROUP) {
      knownRepos = await loadKnownHookMonitoringRepos();
    }
  } catch (err) {
    hookError = err instanceof Error ? err.message : String(err);
  }

  const hasLocal =
    localRequests != null && localRequests.conversations.length > 0;

  if (!hasLocal || localRequests == null) {
    return (
      <div className="space-y-4 p-4">
        <Link
          href="/monitoring"
          className="text-xs text-fg-subtle hover:text-fg"
        >
          ← All projects
        </Link>
        {hookError ? (
          <p className="text-sm text-warning-fg" role="alert">
            Local requests unavailable: {hookError}
          </p>
        ) : null}
        <Panel>
          <EmptyState
            title="No such project"
            description={`No local requests are recorded for “${project}”.`}
          />
        </Panel>
      </div>
    );
  }

  const localCount = localRequests.conversations.length;
  const chargedLabel =
    localRequests.chargedCentsTotal != null
      ? formatHookCostUsd(localRequests.chargedCentsTotal)
      : null;
  const href = projectHref(project);
  const repoUrl =
    project !== HOOK_NO_REPO_GROUP ? `https://github.com/${project}` : null;

  return (
    <div className="space-y-4 p-4">
      <div>
        <Link
          href="/monitoring"
          className="text-xs text-fg-subtle hover:text-fg"
        >
          ← All projects
        </Link>
        <PageHeader
          className="mt-1"
          title={project === HOOK_NO_REPO_GROUP ? 'No repository' : project}
          meta="Project"
          subtitle={`${localCount} local request${localCount === 1 ? '' : 's'}${chargedLabel ? ` · ${chargedLabel} charged` : ''}`}
          actions={
            <div className="flex items-center gap-3">
              <Link
                href="/hooks/setup"
                className="text-xs text-accent hover:underline"
              >
                Copy stop hook
              </Link>
              {repoUrl ? (
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-accent hover:underline"
                >
                  Open repository ↗
                </a>
              ) : null}
            </div>
          }
        />
      </div>

      {hookError ? (
        <p className="text-sm text-warning-fg" role="alert">
          Local requests unavailable: {hookError}
        </p>
      ) : null}

      <ProjectConversationsClient
        projectHref={href}
        initialSort={sort}
        localRequests={localRequests}
        allowAssignRepo={project === HOOK_NO_REPO_GROUP}
        knownRepos={knownRepos}
      />
    </div>
  );
}
