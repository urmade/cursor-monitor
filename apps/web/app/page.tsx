import Link from 'next/link';
import { formatCost, formatDate } from '@/src/lib/format';
import { renamePath, repositoryPath } from '@/src/lib/paths';
import { mergeRepository } from '@/src/server/actions';
import { loadMonitorData } from '@/src/server/data';
import { currentAdmin } from '@/src/server/identity';
import { NO_REPOSITORY_KEY } from '@cursor-monitor/core';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [
    {
      tree,
      hooksTruncated,
      usageTruncated,
      hookCount,
      usageCount,
      mergeRootsWithChildren,
    },
    admin,
  ] = await Promise.all([loadMonitorData(), currentAdmin()]);
  const mergeTargets = tree.projects.filter(
    (project) => project.key !== NO_REPOSITORY_KEY,
  );

  return (
      <div className="stack">
        <header className="page-heading">
          <div>
            <p className="eyebrow">Live overview</p>
            <h1>Repository activity</h1>
            <p className="lede">
              Hook events appear immediately. Cursor Team API usage is fetched
              every five minutes and joined to conversations without duplicating
              overlapping sync windows.
            </p>
          </div>
          <Link className="button button-primary" href="/hooks">
            Configure Team Hooks
          </Link>
        </header>

        <section className="metrics" aria-label="Monitoring totals">
          <div className="metric">
            <span>Repositories</span>
            <strong>{tree.projects.length}</strong>
          </div>
          <div className="metric">
            <span>Hook events</span>
            <strong>{hookCount}</strong>
          </div>
          <div className="metric">
            <span>Usage events</span>
            <strong>{usageCount}</strong>
          </div>
          <div className="metric">
            <span>Charged</span>
            <strong>{formatCost(tree.chargedCents)}</strong>
          </div>
        </section>

        {hooksTruncated || usageTruncated ? (
          <div className="callout">
            This view reached its safety limit. It shows the newest{' '}
            {hooksTruncated ? '5,000 hook events' : ''}
            {hooksTruncated && usageTruncated ? ' and ' : ''}
            {usageTruncated ? '10,000 usage events' : ''}. Historical rows remain
            in the configured database.
          </div>
        ) : null}

        <div className="section-heading">
          <h2>Projects</h2>
          <span className="small subtle">
            {tree.unmatchedUsageEvents} usage event
            {tree.unmatchedUsageEvents === 1 ? '' : 's'} awaiting a matching hook
          </span>
        </div>

        {tree.projects.length === 0 ? (
          <section className="panel empty">
            <h2>No activity yet</h2>
            <p>
              Configure Team Hooks for your organization. The first completed
              Cursor request creates the project automatically.
            </p>
            <Link className="button button-primary" href="/hooks">
              Open Team Hook setup
            </Link>
          </section>
        ) : (
          <section className="grid">
            {tree.projects.map((project) => (
              <article className="project-card" key={project.key}>
                <div>
                  <Link
                    className="project-card-link"
                    href={repositoryPath(project.key)}
                  >
                    <h3>{project.displayName}</h3>
                    <div className="mono small subtle">{project.key}</div>
                    <div className="stats">
                      <span className="stat">
                        <strong>{project.conversationCount}</strong>
                        <span>conversations</span>
                      </span>
                      <span className="stat">
                        <strong>{project.eventCount}</strong>
                        <span>hook events</span>
                      </span>
                      <span className="stat">
                        <strong>{formatCost(project.chargedCents)}</strong>
                        <span>charged</span>
                      </span>
                    </div>
                  </Link>
                  {project.sourceRepositories.length > 1 ? (
                    <span className="badge">
                      {project.sourceRepositories.length} contributing repositories
                    </span>
                  ) : null}
                </div>

                <div className="card-footer row-between">
                  <span className="small subtle">
                    Latest {project.latestAt ? formatDate(project.latestAt) : '—'}
                  </span>
                  {admin && project.key !== NO_REPOSITORY_KEY ? (
                    <Link
                      aria-label={`Rename ${project.displayName}`}
                      className="button button-secondary"
                      href={renamePath(project.key)}
                    >
                      Rename
                    </Link>
                  ) : null}
                </div>

                {admin &&
                project.key !== NO_REPOSITORY_KEY &&
                mergeTargets.length > 1 &&
                !mergeRootsWithChildren.has(project.key) ? (
                  <details className="manage">
                    <summary>Manage repository</summary>
                    <div className="manage-content">
                      <form action={mergeRepository} className="form-row">
                        <input name="source" type="hidden" value={project.key} />
                        <label className="field">
                          <span>Attach to project</span>
                          <select defaultValue="" name="target" required>
                            <option disabled value="">
                              Select target…
                            </option>
                            {mergeTargets
                              .filter((target) => target.key !== project.key)
                              .map((target) => (
                                <option key={target.key} value={target.key}>
                                  {target.displayName}
                                </option>
                              ))}
                          </select>
                        </label>
                        <button className="button button-secondary" type="submit">
                          Merge
                        </button>
                      </form>
                    </div>
                  </details>
                ) : null}
              </article>
            ))}
          </section>
        )}
      </div>
  );
}
