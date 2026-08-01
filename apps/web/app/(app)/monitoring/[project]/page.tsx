import { EmptyState, PageHeader, Panel } from '@nexus/ui';
import Link from 'next/link';
import {
  ProjectConversationsClient,
  type ProjectConversationRow,
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
  runTargetBranch,
  type ProjectRunSections,
} from '../../../../src/server/cursor';
import { formatHookCostUsd } from '../../../../src/lib/monitoring-format';
import { loadHookSignalsForRepo } from '../../../../src/server/hook-signals';
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

  let sections: ProjectRunSections | null = null;
  let truncatedEnrichment = false;
  let repoUrl: string | null = null;
  let cloudError: string | null = null;

  if (auth.credentials.length > 0 && auth.combinedFingerprint) {
    try {
      const detail = await getCachedProjectDetail(
        auth.credentials.map((c) => ({
          client: c.client,
          fingerprint: c.fingerprint,
        })),
        project,
        sort,
      );

      if (!('empty' in detail)) {
        sections = detail.sections;
        truncatedEnrichment = detail.truncatedEnrichment;
        repoUrl = detail.repoUrl;
      }
    } catch (err) {
      cloudError = err instanceof Error ? err.message : String(err);
    }
  } else if (auth.error) {
    cloudError = auth.error;
  }

  let localRequests = null;
  let hookError: string | null = null;
  try {
    localRequests = await loadHookSignalsForRepo(project);
  } catch (err) {
    hookError = err instanceof Error ? err.message : String(err);
  }

  const hasCloud =
    sections != null &&
    (sections.automations.length > 0 || sections.userRequests.length > 0);
  const hasLocal =
    localRequests != null && localRequests.conversations.length > 0;

  if (!hasCloud && !hasLocal) {
    return (
      <div className="space-y-4 p-4">
        <Link
          href="/monitoring"
          className="text-xs text-fg-subtle hover:text-fg"
        >
          ← All projects
        </Link>
        {cloudError ? (
          <p className="text-sm text-danger-fg" role="alert">
            {cloudError}
          </p>
        ) : null}
        {hookError ? (
          <p className="text-sm text-warning-fg" role="alert">
            Local requests unavailable: {hookError}
          </p>
        ) : null}
        <Panel>
          <EmptyState
            title="No such project"
            description={`No Cloud Agent conversations or local requests are recorded for “${project}”.`}
          />
        </Panel>
      </div>
    );
  }

  const toRow = (
    c: ProjectRunSections['userRequests'][number],
    automation?: { automationId: string; automationName: string },
  ): ProjectConversationRow => {
    const pr = c.prs[0] ?? null;
    return {
      id: c.id,
      name: c.name?.trim() || '(unnamed conversation)',
      status: conversationDisplayStatus(c),
      chargedCents: preferredChargedCents(c),
      createdAt: c.createdAt,
      source: c.source,
      branch: runTargetBranch(c),
      automationId: automation?.automationId,
      automationName: automation?.automationName,
      prUrl: pr?.prUrl ?? null,
      prLabel: pr?.label ?? null,
      prName: resolvePrDisplayName({
        prTitle: pr?.title,
        conversations: [c],
      }),
      prNumber: formatPrNumberLabel(pr?.prUrl ?? pr?.label),
    };
  };
  const runRows: ProjectConversationRow[] = [
    ...(sections?.automations ?? []).flatMap((g) =>
      g.conversations.map((c) =>
        toRow(c, { automationId: g.automationId, automationName: g.automationName }),
      ),
    ),
    ...(sections?.userRequests ?? []).map((c) => toRow(c)),
  ];

  const allRuns = [
    ...(sections?.automations.flatMap((g) => g.conversations) ?? []),
    ...(sections?.userRequests ?? []),
  ];
  const cloudCharged = allRuns.reduce((sum, c) => {
    const cc = preferredChargedCents(c);
    return cc != null ? sum + cc : sum;
  }, 0);
  const localCharged = localRequests?.chargedCentsTotal ?? 0;
  const anyCloudCost = allRuns.some((c) => preferredChargedCents(c) != null);
  const anyLocalCost = localRequests?.chargedCentsTotal != null;
  const totalCharged =
    anyCloudCost || anyLocalCost
      ? cloudCharged + (anyLocalCost ? localCharged : 0)
      : 0;
  const unfinishedCount = allRuns.filter((a) =>
    runDidNotFinish(conversationDisplayStatus(a)),
  ).length;
  const href = projectHref(project);
  const localCount = localRequests?.conversations.length ?? 0;
  const automationCount = sections?.automations.length ?? 0;
  const cloudAgentCount = sections?.userRequests.length ?? 0;
  const chargedLabel =
    anyCloudCost || anyLocalCost
      ? anyLocalCost && !anyCloudCost
        ? formatHookCostUsd(totalCharged)
        : formatCentsUsd(totalCharged)
      : null;

  if (!repoUrl && project !== NO_REPO_GROUP) {
    repoUrl = `https://github.com/${project}`;
  }

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
          subtitle={`${automationCount} automation${automationCount === 1 ? '' : 's'} · ${cloudAgentCount} Cloud Agent · ${localCount} local request${localCount === 1 ? '' : 's'}${chargedLabel ? ` · ${chargedLabel} charged` : ''}${unfinishedCount > 0 ? ` · ${unfinishedCount} did not finish` : ''}`}
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

      {cloudError && !hasCloud ? (
        <p className="text-sm text-warning-fg" role="alert">
          Cloud Agent data unavailable: {cloudError}
        </p>
      ) : null}
      {hookError ? (
        <p className="text-sm text-warning-fg" role="alert">
          Local requests unavailable: {hookError}
        </p>
      ) : null}

      <ProjectConversationsClient
        projectHref={href}
        initialSort={sort}
        runs={runRows}
        localRequests={localRequests}
      />

      {truncatedEnrichment ? (
        <p className="text-xs text-fg-subtle">
          Cost/PR enrichment capped — totals may be partial.
        </p>
      ) : null}
    </div>
  );
}
