import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  canonicalRepository,
  displayConversationKey,
  NO_REPOSITORY_KEY,
  UNKNOWN_CONVERSATION_KEY,
  type MonitorConversation,
} from '@cursor-monitor/core';
import {
  renameBranch,
  renameConversation,
  renameRepository,
  unmergeRepository,
} from '@/src/server/actions';
import {
  loadBranchNames,
  loadConversationNames,
  loadRepositoryProject,
} from '@/src/server/data';
import { currentAdmin } from '@/src/server/identity';
import { RenameControl } from '@/src/components/RenameControl';
import { conversationBranchKey } from '@/src/lib/branches';
import { formatCost, formatDate, formatDuration } from '@/src/lib/format';
import { repositoryPath } from '@/src/lib/paths';

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
  const [{ sort }, admin, branchNames, conversationNames] = await Promise.all([
    searchParams,
    currentAdmin(),
    loadBranchNames(project.key),
    loadConversationNames(),
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
            <RenameControl
              action={renameRepository}
              ariaLabel={`Rename ${project.displayName}`}
              currentName={
                project.displayName === project.key ? '' : project.displayName
              }
              eyebrow="Display preference"
              hiddenFields={{ repositoryKey: project.key }}
              lede="This label appears on the dashboard and project page. The canonical repository key, URLs, and raw hook payloads stay the same."
              placeholder={project.key}
              stableLabel="Repository key"
              stableValue={project.key}
              title={`Rename ${project.displayName}`}
            />
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
                  <RenameControl
                    action={renameBranch}
                    ariaLabel={`Rename ${label || branch}`}
                    currentName={label ?? ''}
                    eyebrow="Display preference"
                    hiddenFields={{
                      repositoryKey: project.key,
                      branchKey: branch,
                    }}
                    lede="This label groups conversations on the project page. The underlying git branch name is unchanged."
                    placeholder={branch}
                    stableLabel="Branch key"
                    stableValue={branch}
                    title={`Rename ${label || branch}`}
                  />
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
                          <RenameControl
                            action={renameConversation}
                            ariaLabel={`Rename ${conversation.displayName}`}
                            currentName={
                              conversationNames.get(conversation.key)?.trim() ??
                              ''
                            }
                            eyebrow="Display preference"
                            hiddenFields={{
                              conversationKey: conversation.key,
                              repositoryKey: project.key,
                            }}
                            lede="This label appears on the project page. Conversation identity, usage joins, and raw payloads stay on the original Cursor conversation ID."
                            placeholder={
                              conversation.userEmail?.trim() ||
                              displayConversationKey(conversation.key)
                            }
                            stableLabel="Conversation ID"
                            stableValue={conversation.id ?? conversation.key}
                            title={`Rename ${conversation.displayName}`}
                          />
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
