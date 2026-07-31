import { EmptyState, PageHeader, Panel } from '@nexus/ui';
import Link from 'next/link';
import {
  ProjectConversationsClient,
  type ProjectSectionsView,
} from '../../../../src/components/ProjectConversationsClient';
import {
  conversationDisplayStatus,
  formatCentsUsd,
  formatPrNumberLabel,
  NO_REPO_GROUP,
  normalizeRepoLabel,
  parseConversationGroupSort,
  preferredChargedCents,
  resolveCursorAuth,
  resolvePrDisplayName,
  runDidNotFinish,
} from '../../../../src/server/cursor';
import { getCachedProjectDetail } from '../../../../src/server/monitoring-cache';

export const dynamic = 'force-dynamic';

function projectHref(project: string): string {
  return `/monitoring/${encodeURIComponent(project)}`;
}

/** Canonical project key: lowercased repo label, or the no-repo sentinel. */
function canonicalProject(project: string): string {
  return project === NO_REPO_GROUP ? project : normalizeRepoLabel(project);
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
  if (auth.credentials.length === 0 || !auth.combinedFingerprint) {
    return (
      <div className="space-y-4 p-4">
        <Link href="/monitoring" className="text-sm text-accent hover:underline">
          ← Monitoring
        </Link>
        <p className="text-sm text-danger-fg" role="alert">
          {auth.error ??
            'Connect one or more Cursor API keys on the Monitoring page (or set CURSOR_API_KEY).'}
        </p>
      </div>
    );
  }

  const detail = await getCachedProjectDetail(
    auth.credentials.map((c) => ({
      client: c.client,
      fingerprint: c.fingerprint,
    })),
    project,
    sort,
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
            description={`No conversations are working against “${project}” with the connected Cursor API key(s).`}
          />
        </Panel>
      </div>
    );
  }

  const { sections, enrichedCount, truncatedEnrichment, repoUrl } = detail;

  const sectionViews: ProjectSectionsView = {
    automations: sections.automations.map((g) => ({
      automationId: g.automationId,
      automationName: g.automationName,
      totalChargedCents: g.totalChargedCents,
      latestCreatedAt: g.latestCreatedAt,
      conversations: g.conversations.map((c) => {
        const pr = c.prs[0] ?? null;
        return {
          id: c.id,
          name: c.name?.trim() || '(unnamed conversation)',
          status: conversationDisplayStatus(c),
          chargedCents: preferredChargedCents(c),
          createdAt: c.createdAt,
          source: c.source,
          automationId: g.automationId,
          automationName: g.automationName,
          prUrl: pr?.prUrl ?? null,
          prLabel: pr?.label ?? null,
          prName: resolvePrDisplayName({
            prTitle: pr?.title,
            conversations: [c],
          }),
          prNumber: formatPrNumberLabel(pr?.prUrl ?? pr?.label),
        };
      }),
    })),
    userRequests: sections.userRequests.map((c) => {
      const pr = c.prs[0] ?? null;
      return {
        id: c.id,
        name: c.name?.trim() || '(unnamed conversation)',
        status: conversationDisplayStatus(c),
        chargedCents: preferredChargedCents(c),
        createdAt: c.createdAt,
        source: c.source,
        prUrl: pr?.prUrl ?? null,
        prLabel: pr?.label ?? null,
        prName: resolvePrDisplayName({
          prTitle: pr?.title,
          conversations: [c],
        }),
        prNumber: formatPrNumberLabel(pr?.prUrl ?? pr?.label),
      };
    }),
  };

  const allRuns = [
    ...sections.automations.flatMap((g) => g.conversations),
    ...sections.userRequests,
  ];
  const totalCharged = allRuns.reduce((sum, c) => {
    const cc = preferredChargedCents(c);
    return cc != null ? sum + cc : sum;
  }, 0);
  const anyCost = allRuns.some((c) => preferredChargedCents(c) != null);
  const unfinishedCount = allRuns.filter((a) =>
    runDidNotFinish(conversationDisplayStatus(a)),
  ).length;
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
          subtitle={`${enrichedCount} conversation${enrichedCount === 1 ? '' : 's'} · ${sections.automations.length} automation${sections.automations.length === 1 ? '' : 's'} · ${sections.userRequests.length} user request${sections.userRequests.length === 1 ? '' : 's'}${anyCost ? ` · ${formatCentsUsd(totalCharged)} charged` : ''}${unfinishedCount > 0 ? ` · ${unfinishedCount} did not finish` : ''}`}
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
        sections={sectionViews}
      />

      {truncatedEnrichment ? (
        <p className="text-xs text-fg-subtle">
          Cost/PR enrichment capped — totals may be partial.
        </p>
      ) : null}
    </div>
  );
}
