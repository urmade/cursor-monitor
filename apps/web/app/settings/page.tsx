import type { Metadata } from 'next';
import { runTeamSync } from '@/src/server/actions';
import {
  loadConfigurationStatus,
  loadSyncStatus,
} from '@/src/server/data';
import { formatDate } from '@/src/lib/format';

export const metadata: Metadata = { title: 'Operations' };
export const dynamic = 'force-dynamic';

function configured(value: boolean) {
  return (
    <span className={value ? 'badge badge-success' : 'badge badge-warning'}>
      {value ? 'Configured' : 'Missing'}
    </span>
  );
}

export default async function SettingsPage() {
  const configuration = loadConfigurationStatus();
  let syncs: Awaited<ReturnType<typeof loadSyncStatus>> = [];
  let databaseError: string | null = null;
  try {
    syncs = await loadSyncStatus();
  } catch (error) {
    databaseError = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Data sources and sync health</h1>
          <p className="lede">
            Hook ingestion and Cursor Team API polling remain independent. A Team
            API outage never prevents incoming hook events from being stored.
          </p>
        </div>
        <form action={runTeamSync}>
          <button
            className="button button-primary"
            disabled={!configuration.teamApi || Boolean(databaseError)}
            type="submit"
          >
            Sync now
          </button>
        </form>
      </header>

      <section className="grid">
        <article className="panel">
          <div className="row-between">
            <h2>{configuration.databaseAdapter} database</h2>
            {configured(!databaseError)}
          </div>
          <p className="small muted">
            Stores hook events, deduplicated Team usage, display preferences, and
            sync history.
          </p>
          {databaseError ? (
            <p className="small" style={{ color: 'var(--danger)' }}>
              {databaseError}
            </p>
          ) : null}
        </article>
        <article className="panel">
          <div className="row-between">
            <h2>Cursor usage API</h2>
            {configured(configuration.teamApi)}
          </div>
          <p className="small muted">
            {configuration.teamApiMode ??
              'Add Team or Organization API credentials through encrypted secrets.'}
          </p>
        </article>
        <article className="panel">
          <div className="row-between">
            <h2>Hook authentication</h2>
            {configured(configuration.hookToken)}
          </div>
          <p className="small muted">
            Protects <span className="mono">POST /api/hooks/events</span> and is
            embedded only in authenticated installer downloads.
          </p>
        </article>
        <article className="panel">
          <div className="row-between">
            <h2>Scheduled sync</h2>
            {configured(configuration.cronSecret)}
          </div>
          <p className="small muted">
            Vercel invokes <span className="mono">/api/cron/sync</span> every five
            minutes. Poll windows overlap by one hour and deduplicate by fingerprint.
          </p>
        </article>
      </section>

      <section className="panel stack">
        <div>
          <h2>Recent Team API syncs</h2>
          <p className="small muted">
            The newest ten attempts are retained here; complete history remains in
            the database.
          </p>
        </div>
        {syncs.length === 0 ? (
          <p className="small subtle">No sync attempts have run yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Window</th>
                  <th>Fetched</th>
                  <th>Inserted</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {syncs.map((sync) => (
                  <tr key={sync.id}>
                    <td>
                      <span
                        className={
                          sync.status === 'succeeded'
                            ? 'badge badge-success'
                            : sync.status === 'failed'
                              ? 'badge badge-danger'
                              : 'badge badge-warning'
                        }
                      >
                        {sync.status}
                      </span>
                    </td>
                    <td>{formatDate(sync.startedAt)}</td>
                    <td>
                      {formatDate(sync.windowStartedAt)}
                      <br />
                      <span className="subtle">to {formatDate(sync.windowEndedAt)}</span>
                    </td>
                    <td>{sync.fetchedCount}</td>
                    <td>{sync.insertedCount}</td>
                    <td className="muted">
                      {sync.error ??
                        `${sync.pages} page${sync.pages === 1 ? '' : 's'}${
                          sync.truncated ? ' · truncated' : ''
                        }`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Change configuration safely</h2>
        <p className="small muted">
          Select one <span className="mono">DATABASE_ADAPTER</span> and configure
          its server-only <span className="mono">DATABASE_URL</span>. The
          reference internalsphere deployment supplies the default adapter&apos;s
          alias through the managed integration. See{' '}
          <span className="mono">docs/operations.md</span> for exact key names,
          failure modes, and verification commands. Never commit plaintext
          credentials.
        </p>
      </section>
    </div>
  );
}
