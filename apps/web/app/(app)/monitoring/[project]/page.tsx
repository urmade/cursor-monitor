import { EmptyState, PageHeader, Panel } from '@nexus/ui';
import Link from 'next/link';
import {
  ProjectConversationsClient,
  type ProjectConversationGroupView,
} from '../../../../src/components/ProjectConversationsClient';
import {
  agentRepoLabels,
  conversationDisplayStatus,
  formatCentsUsd,
  formatPrNumberLabel,
  NO_PR_GROUP,
  NO_REPO_GROUP,
  normalizeRepoLabel,
  parseConversationGroupSort,
  preferredChargedCents,
  resolveCursorAuth,
  resolvePrDisplayName,
  runDidNotFinish,
} from '../../../../src/server/cursor';
import { getCachedProjectDetail } from '../../../../src/server/monitoring-cache';
import type { AgentSummary } from '@nexus/cursor-client';

export const dynamic = 'force-dynamic';

function projectHref(project: string): string {
  return `/monitoring/${encodeURIComponent(project)}`;
}

/** Canonical project key: lowercased repo label, or the no-repo sentinel. */
function canonicalProject(project: string): string {
  return project === NO_REPO_GROUP ? project : normalizeRepoLabel(project);
}

function agentsForProject(
  agents: AgentSummary[],
  project: string,
): AgentSummary[] {
  const key = canonicalProject(project);
  if (key === NO_REPO_GROUP) {
    return agents.filter((a) => agentRepoLabels(a.repos).length === 0);
  }
  return agents.filter((a) => agentRepoLabels(a.repos).includes(key));
}

function findRepoUrl(agents: AgentSummary[], project: string): string | null {
  const key = canonicalProject(project);
  for (const agent of agents) {
    for (const repo of agent.repos ?? []) {
      if (!repo.url) continue;
      if (agentRepoLabels([repo]).includes(key)) {
        const url = repo.url;
        return url.includes('://') ? url : `https://${url}`;
      }
    }
  }
  return null;
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

  const auth = await resolveCursorAuth();
  if (!auth.client || !auth.fingerprint) {
    return (
      <div className="space-y-4 p-4">
        <Link href="/monitoring" className="text-sm text-accent hover:underline">
          ← Monitoring
        </Link>
        <p className="text-sm text-danger-fg" role="alert">
          {auth.error ??
            'Connect a personal Cursor API key on the Monitoring page (or set CURSOR_API_KEY).'}
        </p>
      </div>
    );
  }

  const detail = await getCachedProjectDetail(
    auth.client,
    auth.fingerprint,
    project,
    sort,
    { agentsForProject, findRepoUrl },
  );

  if ('empty' in detail) {
    return (
      <div className="space-y-4 p-4">
        <Link
          href="/monitoring"
          className="text-xs text-fg-subtle hover:text-fg"
        >
          ← All projects
        </Link>
        <Panel>
          <EmptyState
            title="No such project"
            description={`No conversations are working against “${project}” with this Cursor API key.`}
          />
        </Panel>
      </div>
    );
  }

  const { groups, enrichedCount, truncatedEnrichment, repoUrl } = detail;

  const groupViews: ProjectConversationGroupView[] = groups.map((g) => ({
    key: g.key,
    prUrl: g.pr?.prUrl ?? null,
    prLabel: g.pr?.label ?? null,
    prName: resolvePrDisplayName({
      prTitle: g.pr?.title,
      conversations: g.conversations,
    }),
    prNumber: formatPrNumberLabel(g.pr?.prUrl ?? g.pr?.label),
    branch: g.pr?.branch,
    totalChargedCents: g.totalChargedCents,
    totalRawCents: g.totalRawCents,
    latestCreatedAt: g.latestCreatedAt,
    conversations: g.conversations.map((c) => ({
      id: c.id,
      name: c.name?.trim() || '(unnamed conversation)',
      status: conversationDisplayStatus(c),
      chargedCents: preferredChargedCents(c),
      createdAt: c.createdAt,
    })),
  }));

  const totalCharged = groups.reduce(
    (sum, g) => (g.totalChargedCents != null ? sum + g.totalChargedCents : sum),
    0,
  );
  const anyCost = groups.some((g) => g.totalChargedCents != null);
  const prGroupCount = groups.filter((g) => g.key !== NO_PR_GROUP).length;
  const unfinishedCount = groups
    .flatMap((g) => g.conversations)
    .filter((a) => runDidNotFinish(conversationDisplayStatus(a))).length;
  const href = projectHref(project);

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
          title={project === NO_REPO_GROUP ? 'No repository' : project}
          meta="Project"
          subtitle={`${enrichedCount} conversation${enrichedCount === 1 ? '' : 's'} · ${prGroupCount} pull request${prGroupCount === 1 ? '' : 's'}${anyCost ? ` · ${formatCentsUsd(totalCharged)} charged` : ''}${unfinishedCount > 0 ? ` · ${unfinishedCount} did not finish` : ''}`}
          actions={
            repoUrl ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent hover:underline"
              >
                Open repository ↗
              </a>
            ) : undefined
          }
        />
      </div>

      <ProjectConversationsClient
        projectHref={href}
        initialSort={sort}
        groups={groupViews}
        prTitlePrefix={project}
      />

      {truncatedEnrichment ? (
        <p className="text-xs text-fg-subtle">
          Cost/PR enrichment capped — totals may be partial.
        </p>
      ) : null}
    </div>
  );
}
