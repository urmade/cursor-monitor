import { EmptyState, PageHeader, Panel } from '@nexus/ui';
import Link from 'next/link';
import { CursorApiKeyConnectForm } from '../../../src/components/CursorApiKeyConnectForm';
import {
  formatApiKeyIdentity,
  formatCentsUsd,
  formatRelativeTime,
  NO_REPO_GROUP,
  resolveCursorAuth,
} from '../../../src/server/cursor';
import { getCachedProjectsPage } from '../../../src/server/monitoring-cache';

export const dynamic = 'force-dynamic';

export default async function MonitoringPage() {
  const auth = await resolveCursorAuth();

  let error: string | null = auth.error;
  let projects: Awaited<ReturnType<typeof getCachedProjectsPage>>['projects'] =
    [];
  let agentCount = 0;
  let truncated = false;
  let truncatedEnrichment = false;

  if (auth.client && auth.fingerprint) {
    try {
      const page = await getCachedProjectsPage(auth.client, auth.fingerprint);
      projects = page.projects;
      agentCount = page.agentCount;
      truncated = page.truncated;
      truncatedEnrichment = page.truncatedEnrichment;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
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
        subtitle="Every repository is a project. Open one to inspect the conversations running against it — grouped by pull request, with their cost."
        meta={
          auth.client && projects.length > 0
            ? `${projects.length} project${projects.length === 1 ? '' : 's'} · ${agentCount} conversation${agentCount === 1 ? '' : 's'}${anyCost ? ` · ${formatCentsUsd(totalCharged)} charged` : ''}`
            : undefined
        }
      />

      <CursorApiKeyConnectForm
        connected={Boolean(auth.client)}
        identityLabel={auth.me ? formatApiKeyIdentity(auth.me) : null}
        source={auth.source}
      />

      {error ? (
        <p className="text-sm text-danger-fg" role="alert">
          {error}
        </p>
      ) : null}

      {auth.client && !error && projects.length === 0 ? (
        <Panel>
          <EmptyState
            title="No conversations yet"
            description="Cloud Agents started in Cursor show up here as conversations, grouped by the repository they work on."
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
                  {project.repo === NO_REPO_GROUP
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
                  {formatCentsUsd(project.totalChargedCents)}
                </span>
                <span className="text-xs text-fg-subtle">charged</span>
              </div>
              <div className="mt-1 text-xs text-fg-muted">
                {project.conversationCount} conversation
                {project.conversationCount === 1 ? '' : 's'}
                {' · '}
                {project.prCount} pull request
                {project.prCount === 1 ? '' : 's'}
              </div>
            </Link>
          ))}
        </div>
      ) : null}

      {auth.client && (truncated || truncatedEnrichment) ? (
        <p className="text-xs text-fg-subtle">
          {truncated
            ? 'Conversation list truncated — hit the API page cap. '
            : ''}
          {truncatedEnrichment
            ? 'Cost/PR enrichment capped — project totals may be partial.'
            : ''}
        </p>
      ) : null}
    </div>
  );
}
