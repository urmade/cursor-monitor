import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  canonicalRepository,
  NO_REPOSITORY_KEY,
  UNKNOWN_CONVERSATION_KEY,
} from '@cursor-monitor/core';
import { unmergeRepository } from '@/src/server/actions';
import {
  loadBranchNames,
  loadRepositoryProject,
} from '@/src/server/data';
import { currentAdmin } from '@/src/server/identity';
import { conversationBranchKey } from '@/src/lib/branches';
import { formatCost, formatDate, formatDuration } from '@/src/lib/format';
import { renamePath, repositoryPath } from '@/src/lib/paths';

export const dynamic = 'force-dynamic';

function statusClass(status: string | null): string {
  const value = status?.toLowerCase() ?? '';
  if (value.includes('complete') || value.includes('finish')) {
    return 'badge badge-success';
  }
  if (value.includes('error') || value.includes('fail')) {
    return 'badge badge-danger';
  }
  if (value.includes('abort') || value.includes('cancel')) {
    return 'badge badge-warning';
  }
  return 'badge';
}

export default async function RepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ repository: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { repository: rawRepository } = await params;
  const requested = canonicalRepository(decodeURIComponent(rawRepository));
  const data = await loadRepositoryProject(requested);
  let project = data.project;
  if (!project) {
    const merged = data.tree.projects.find((candidate) =>
      candidate.sourceRepositories.includes(requested),
    );
    if (merged) {
      redirect(repositoryPath(merged.key));
    }
    notFound();
  }
  project = project!;
  const [{ sort }, admin, branchNames] = await Promise.all([
    searchParams,
    currentAdmin(),
    loadBranchNames(project.key),
  ]);
  const conversations = [...project.conversations].sort((a, b) =>
    sort === 'cost'
      ? (b.chargedCents ?? -1) - (a.chargedCents ?? -1)
      : b.latestAt.localeCompare(a.latestAt),
  );
  const groups = new Map<string, MonitorConversation[]>();
  for (const conversation of conversations) {
    const key = conversationBranchKey(
      conversation,
      project.sourceRepositories.length,
    );
    const group = groups.get(key) ?? [];
    group.push(conversation);
    groups.set(key, group);
  }
  const githubUrl =
    project.key !== NO_REPOSITORY_KEY && project.key.includes('/')
      ? `https://github.com/${project.key}`
      : null;

  return (
    <div className="stack">
      <div className="breadcrumbs">
        <Link href="/">Repositories</Link>
        <span>/</span>
        <span>{project.displayName}</span>
      </div>

      <header className="page-heading">
        <div>
          <p className="eyebrow">Project</p>
          <h1>{project.displayName}</h1>
          <p className="lede mono">{project.key}</p>
        </div>
        <div className="code-actions">
          <Link
            className={`button ${sort === 'cost' ? 'button-primary' : 'button-secondary'}`}
            href={`${repositoryPath(project.key)}?sort=cost`}
          >
            Sort by cost
          </Link>
          <Link
            className={`button ${sort !== 'cost' ? 'button-primary' : 'button-secondary'}`}
            href={repositoryPath(project.key)}
          >
            Sort by activity
          </Link>
          {admin && project.key !== NO_REPOSITORY_KEY ? (
            <Link
              aria-label={`Rename ${project.displayName}`}
              className="button button-secondary"
              href={renamePath(project.key)}
            >
              Rename
            </Link>
          ) : null}
          {githubUrl ? (
            <a className="button button-secondary" href={githubUrl}>
              Open GitHub ↗
            </a>
          ) : null}
        </div>
      </header>

      <section className="metrics">
        <div className="metric">
          <span>Conversations</span>
          <strong>{project.conversationCount}</strong>
        </div>
        <div className="metric">
          <span>Hook events</span>
          <strong>{project.eventCount}</strong>
        </div>
        <div className="metric">
          <span>Charged</span>
          <strong>{formatCost(project.chargedCents)}</strong>
        </div>
        <div className="metric">
          <span>Repositories</span>
          <strong>{project.sourceRepositories.length}</strong>
        </div>
      </section>

      {data.rawPayloadsTruncated ? (
        <div className="callout">
          Raw JSON is loaded for the newest 1,000 hook events in this project.
          Older event metadata and aggregate totals remain visible.
        </div>
      ) : null}

      {project.sourceRepositories.length > 1 ? (
        <section className="panel stack">
          <div>
            <h2>Contributing repositories</h2>
            <p className="small muted">
              Raw events retain the repository reported by each hook. A conversation
              appears under the repository from its newest hook unless an explicit
              merge preference attaches it elsewhere.
            </p>
          </div>
          <div className="form-row">
            {project.sourceRepositories.map((source) => (
              <span className="badge mono" key={source}>
                {source}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {data.attachedRepositories.length > 0 ? (
        <section className="panel stack">
          <div>
            <h2>Explicitly attached repositories</h2>
            <p className="small muted">
              Detaching changes only the project projection; source events remain
              untouched.
            </p>
          </div>
          <div className="form-row">
            {data.attachedRepositories.map((source) => (
              <form action={unmergeRepository} key={source}>
                <input name="repositoryKey" type="hidden" value={source} />
                <button
                  className="button button-secondary"
                  disabled={!admin}
                  type="submit"
                >
                  Detach {source}
                </button>
              </form>
            ))}
          </div>
        </section>
      ) : null}

      {[...groups.entries()].map(([branch, items]) => {
        const label = branchNames.get(branch);
        return (
          <section className="stack" key={branch}>
            <div className="section-heading">
              <div>
                <h2 className="mono">{label || branch}</h2>
                {label ? <span className="small subtle mono">{branch}</span> : null}
              </div>
              <div className="code-actions">
                <span className="badge">
                  {items.length} conversation{items.length === 1 ? '' : 's'}
                </span>
                {admin ? (
                  <Link
                    aria-label={`Rename ${label || branch}`}
                    className="button button-secondary"
                    href={renamePath(project.key, { branch })}
                  >
                    Rename
                  </Link>
                ) : null}
              </div>
            </div>

            <div className="conversation-list">
              {items.map((conversation) => (
                <details className="conversation-card" key={conversation.key}>
                  <summary>
                    <span>
                      <strong>{conversation.displayName}</strong>
                      <small className="mono subtle">
                        {conversation.id ?? 'No conversation id'}
                      </small>
                    </span>
                    <span className={statusClass(conversation.status)}>
                      {conversation.status ?? 'unknown'}
                    </span>
                    <span className="small muted">
                      {conversation.events.length} turn
                      {conversation.events.length === 1 ? '' : 's'}
                    </span>
                    <strong>{formatCost(conversation.chargedCents)}</strong>
                  </summary>
                  <div className="conversation-body">
                    <div className="row-between">
                      <div className="small muted">
                        {conversation.userEmail ?? 'Unknown user'} ·{' '}
                        {conversation.model ?? 'Unknown model'} ·{' '}
                        {formatDuration(conversation.durationMs)}
                      </div>
                      <div className="code-actions">
                        <span className="small subtle">
                          Latest {formatDate(conversation.latestAt)}
                        </span>
                        {admin &&
                        conversation.key !== UNKNOWN_CONVERSATION_KEY ? (
                          <Link
                            aria-label={`Rename ${conversation.displayName}`}
                            className="button button-secondary"
                            href={renamePath(project.key, {
                              conversation: conversation.key,
                            })}
                          >
                            Rename
                          </Link>
                        ) : null}
                      </div>
                    </div>

                    <div className="event-list">
                      {conversation.events.map((event) => (
                        <details className="event" key={event.id}>
                          <summary>
                            <span>
                              <span className={statusClass(event.status)}>
                                {event.status ?? event.eventName}
                              </span>{' '}
                              <span className="small muted">
                                {event.model ?? 'Unknown model'} ·{' '}
                                {formatDuration(event.durationMs)}
                              </span>
                            </span>
                            <span className="small subtle">
                              {formatDate(event.occurredAt)}
                            </span>
                          </summary>
                          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                        </details>
                      ))}
                    </div>
                  </div>
                </details>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
