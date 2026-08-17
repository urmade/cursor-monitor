import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  canonicalRepository,
  NO_REPOSITORY_KEY,
  type MonitorConversation,
} from '@cursor-monitor/core';
import {
  renameBranch,
  renameConversation,
  unmergeRepository,
} from '@/src/server/actions';
import {
  loadBranchNames,
  loadRepositoryProject,
} from '@/src/server/data';
import { currentAdmin } from '@/src/server/identity';
import { formatCost, formatDate, formatDuration } from '@/src/lib/format';

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

function branchKey(
  conversation: MonitorConversation,
  repositoryCount: number,
): string {
  const branch = conversation.branch || 'No branch';
  return repositoryCount > 1
    ? `${conversation.sourceRepositories[0] ?? conversation.repositoryKey}/${branch}`
    : branch;
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
      redirect(`/repositories/${encodeURIComponent(merged.key)}`);
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
    const key = branchKey(conversation, project.sourceRepositories.length);
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
            href={`/repositories/${encodeURIComponent(project.key)}?sort=cost`}
          >
            Sort by cost
          </Link>
          <Link
            className={`button ${sort !== 'cost' ? 'button-primary' : 'button-secondary'}`}
            href={`/repositories/${encodeURIComponent(project.key)}`}
          >
            Sort by activity
          </Link>
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

      {project.sourceRepositories.length > 1 ? (
        <section className="panel stack">
          <div>
            <h2>Merged repositories</h2>
            <p className="small muted">
              Events retain their original repository key. This project combines
              them only for display and cost aggregation.
            </p>
          </div>
          <div className="form-row">
            {project.sourceRepositories.map((source) => (
              <form action={unmergeRepository} key={source}>
                <input name="repositoryKey" type="hidden" value={source} />
                <button
                  className="button button-secondary"
                  disabled={!admin || source === project.key}
                  type="submit"
                >
                  {source === project.key ? `${source} · root` : `Detach ${source}`}
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
                  <details className="manage">
                    <summary>Rename branch</summary>
                    <form action={renameBranch} className="form-row manage-content">
                      <input name="repositoryKey" type="hidden" value={project.key} />
                      <input name="branchKey" type="hidden" value={branch} />
                      <label className="field">
                        <span>Display name</span>
                        <input
                          defaultValue={label ?? ''}
                          maxLength={120}
                          name="displayName"
                          placeholder={branch}
                        />
                      </label>
                      <button className="button button-secondary" type="submit">
                        Save
                      </button>
                    </form>
                  </details>
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
                      <div className="small subtle">
                        Latest {formatDate(conversation.latestAt)}
                      </div>
                    </div>

                    {admin ? (
                      <form action={renameConversation} className="form-row">
                        <input
                          name="conversationKey"
                          type="hidden"
                          value={conversation.key}
                        />
                        <input
                          name="repositoryKey"
                          type="hidden"
                          value={project.key}
                        />
                        <label className="field">
                          <span>Conversation display name</span>
                          <input
                            maxLength={120}
                            name="displayName"
                            placeholder={conversation.displayName}
                          />
                        </label>
                        <button className="button button-secondary" type="submit">
                          Rename
                        </button>
                      </form>
                    ) : null}

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
