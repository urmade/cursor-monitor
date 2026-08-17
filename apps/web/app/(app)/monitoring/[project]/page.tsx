import { EmptyState, PageHeader, Panel } from '@nexus/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ProjectConversationsClient } from '../../../../src/components/ProjectConversationsClient';
import { MonitoringMergedMembers } from '../../../../src/components/MonitoringRepoManage';
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
import {
  loadMonitoringBranchPrefs,
  loadMonitoringRepoPrefs,
  memberReposForRoot,
  prefsByRepo,
  resolveMergeRoot,
} from '../../../../src/server/monitoring-repo-prefs';
import { optionalSession } from '../../../../src/server/session';

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

  const session = await optionalSession();
  const prefsList = session
    ? await loadMonitoringRepoPrefs(session.orgId)
    : [];
  const prefs = prefsByRepo(prefsList);

  let displayName = project === HOOK_NO_REPO_GROUP ? 'No repository' : project;
  let memberRepos: string[] = [project];
  let attachedMembers: string[] = [];
  let branchLabels: Record<string, string> = {};

  if (project !== HOOK_NO_REPO_GROUP) {
    const root = resolveMergeRoot(project, prefs);
    if (root !== project) {
      redirect(`/monitoring/${encodeURIComponent(root)}`);
    }
    const known = await loadKnownHookMonitoringRepos();
    memberRepos = memberReposForRoot(project, known, prefs);
    attachedMembers = memberRepos.filter((r) => r !== project);
    const rootPref = prefs.get(project);
    if (rootPref?.displayName) displayName = rootPref.displayName;
  }

  if (session) {
    branchLabels = await loadMonitoringBranchPrefs(session.orgId, project);
  }

  let localRequests = null;
  let hookError: string | null = null;
  let knownRepos: string[] = [];
  try {
    localRequests = await loadHookSignalsForRepo(project, 500, {
      sourceRepos: memberRepos,
    });
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
            description={`No local requests are recorded for “${displayName}”.`}
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
  const subtitleParts = [
    `${localCount} local request${localCount === 1 ? '' : 's'}`,
    chargedLabel ? `${chargedLabel} charged` : null,
    attachedMembers.length > 0
      ? `${attachedMembers.length + 1} repositories`
      : null,
  ].filter(Boolean);

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
          title={displayName}
          meta="Project"
          subtitle={subtitleParts.join(' · ')}
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
        {displayName !== project && project !== HOOK_NO_REPO_GROUP ? (
          <p className="mt-1 font-mono text-xs text-fg-subtle">{project}</p>
        ) : null}
      </div>

      {hookError ? (
        <p className="text-sm text-warning-fg" role="alert">
          Local requests unavailable: {hookError}
        </p>
      ) : null}

      {session ? (
        <MonitoringMergedMembers
          parentRepo={project}
          members={attachedMembers}
        />
      ) : null}
      <ProjectConversationsClient
        projectHref={href}
        initialSort={sort}
        localRequests={localRequests}
        allowAssignRepo={project === HOOK_NO_REPO_GROUP}
        knownRepos={knownRepos}
        projectRepo={project}
        branchLabels={branchLabels}
        manageEnabled={Boolean(session)}
      />
    </div>
  );
}
