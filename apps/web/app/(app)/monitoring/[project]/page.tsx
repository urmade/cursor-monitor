import { EmptyState, PageHeader, Panel, PanelBody, PanelHeader } from '@nexus/ui';
import Link from 'next/link';
import { RunStatusBadge } from '../../../../src/components/RunStatusBadge';
import {
  agentRepoLabels,
  enrichAgentsWithPrAndCost,
  formatCentsUsd,
  formatRelativeTime,
  groupConversationsByPr,
  NO_PR_GROUP,
  NO_REPO_GROUP,
  parseConversationGroupSort,
  preferredChargedCents,
  resolveCursorAuth,
  runDidNotFinish,
  sortConversationGroups,
  type ConversationGroupSort,
} from '../../../../src/server/cursor';

export const dynamic = 'force-dynamic';

function projectHref(project: string, sort?: ConversationGroupSort): string {
  const base = `/monitoring/${encodeURIComponent(project)}`;
  return sort ? `${base}?sort=${sort}` : base;
}

function SortControl({
  project,
  active,
}: {
  project: string;
  active: ConversationGroupSort;
}) {
  const options: Array<{ slug: ConversationGroupSort; label: string }> = [
    { slug: 'cost', label: 'Total cost' },
    { slug: 'created', label: 'Created at' },
  ];
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fg-subtle">Sort</span>
      <div className="inline-flex items-center rounded-md border border-border bg-surface p-0.5">
        {options.map((opt) => (
          <Link
            key={opt.slug}
            href={projectHref(project, opt.slug)}
            aria-current={active === opt.slug ? 'true' : undefined}
            className={
              active === opt.slug
                ? 'rounded bg-[var(--nx-selected)] px-2 py-1 text-xs font-medium text-fg'
                : 'rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg'
            }
          >
            {opt.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export default async function ProjectMonitoringPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { project: rawProject } = await params;
  const project = decodeURIComponent(rawProject);
  const sp = await searchParams;
  const sort = parseConversationGroupSort(sp.sort);

  const auth = await resolveCursorAuth();
  if (!auth.client) {
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

  const client = auth.client;
  const page = await client.listAllAgents({ pageSize: 50, maxPages: 40 });
  const inProject = agentsForProject(page.items, project);

  if (inProject.length === 0) {
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

  const { agents: enriched, truncatedEnrichment } =
    await enrichAgentsWithPrAndCost(client, inProject, {
      concurrency: 8,
      limit: 100,
    });

  const groups = sortConversationGroups(groupConversationsByPr(enriched), sort);

  const totalCharged = groups.reduce(
    (sum, g) => (g.totalChargedCents != null ? sum + g.totalChargedCents : sum),
    0,
  );
  const anyCost = groups.some((g) => g.totalChargedCents != null);
  const prGroupCount = groups.filter((g) => g.key !== NO_PR_GROUP).length;
  const unfinishedCount = enriched.filter((a) => runDidNotFinish(a.status)).length;
  const repoUrl = findRepoUrl(inProject, project);

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
          subtitle={`${enriched.length} conversation${enriched.length === 1 ? '' : 's'} · ${prGroupCount} pull request${prGroupCount === 1 ? '' : 's'}${anyCost ? ` · ${formatCentsUsd(totalCharged)} charged` : ''}${unfinishedCount > 0 ? ` · ${unfinishedCount} did not finish` : ''}`}
          actions={
            <div className="flex items-center gap-3">
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
              <SortControl project={project} active={sort} />
            </div>
          }
        />
      </div>

      {groups.length === 0 ? (
        <Panel>
          <EmptyState
            title="No conversations in this project"
            description="Cloud Agents started against this repository will appear here."
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <Panel key={group.key}>
              <PanelHeader>
                <div className="flex min-w-0 items-baseline gap-2">
                  {group.pr ? (
                    <a
                      href={group.pr.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-accent hover:underline"
                    >
                      {prTitle(group.pr.label, project)}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-fg-muted">
                      No pull request
                    </span>
                  )}
                  {group.pr?.branch ? (
                    <span className="truncate font-mono text-xs text-fg-subtle">
                      {group.pr.branch}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-baseline gap-2">
                  <span className="text-xs text-fg-subtle">
                    {group.conversations.length} conversation
                    {group.conversations.length === 1 ? '' : 's'}
                  </span>
                  <span className="text-sm font-medium tabular-nums text-fg">
                    {formatCentsUsd(group.totalChargedCents)}
                  </span>
                </div>
              </PanelHeader>
              <PanelBody className="p-0">
                <ul className="divide-y divide-border">
                  {group.conversations.map((agent) => {
                    const charged = preferredChargedCents(agent);
                    return (
                      <li key={`${group.key}-${agent.id}`}>
                        <Link
                          href={`${projectHref(project)}/conversations/${encodeURIComponent(agent.id)}`}
                          className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-[var(--nx-hover)]"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-fg">
                            {agent.name?.trim() || '(unnamed conversation)'}
                          </span>
                          <RunStatusBadge status={agent.status} />
                          <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums text-fg">
                            {formatCentsUsd(charged)}
                          </span>
                          <span className="w-16 shrink-0 text-right text-xs text-fg-subtle">
                            {agent.createdAt
                              ? formatRelativeTime(agent.createdAt)
                              : '—'}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </PanelBody>
            </Panel>
          ))}
        </div>
      )}

      {truncatedEnrichment ? (
        <p className="text-xs text-fg-subtle">
          Cost/PR enrichment capped — totals may be partial.
        </p>
      ) : null}
    </div>
  );
}

function agentsForProject<T extends { repos?: Array<{ url?: string }> }>(
  agents: T[],
  project: string,
): T[] {
  if (project === NO_REPO_GROUP) {
    return agents.filter((a) => agentRepoLabels(a.repos).length === 0);
  }
  return agents.filter((a) => agentRepoLabels(a.repos).includes(project));
}

function findRepoUrl(
  agents: Array<{ repos?: Array<{ url?: string }> }>,
  project: string,
): string | null {
  for (const agent of agents) {
    for (const repo of agent.repos ?? []) {
      if (!repo.url) continue;
      if (agentRepoLabels([repo]).includes(project)) {
        const url = repo.url;
        return url.includes('://') ? url : `https://${url}`;
      }
    }
  }
  return null;
}

/** Inside a project page the `owner/repo` prefix of a PR label is redundant. */
function prTitle(label: string, project: string): string {
  const prefix = `${project}#`;
  return label.startsWith(prefix) ? `#${label.slice(prefix.length)}` : label;
}
