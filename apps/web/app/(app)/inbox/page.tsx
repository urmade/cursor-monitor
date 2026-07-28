import {
  getInFlightSummary,
  listInbox,
  listProjects,
  createFlagReader,
} from '@nexus/core';
import { InboxClient } from '../../../src/components/InboxClient';
import { requireSession } from '../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const { ctx } = await requireSession();
  const flags = createFlagReader(ctx.db);
  const inboxEnabled = await flags.isEnabled('p6.inbox');

  const projectsR = await listProjects(ctx);
  const projects = projectsR.ok ? projectsR.value : [];

  const [inboxR, flightR] = await Promise.all([
    listInbox(ctx, { limit: 200 }),
    getInFlightSummary(ctx),
  ]);

  const groups = inboxR.ok ? inboxR.value.groups : [];
  const totalOpen = inboxR.ok ? inboxR.value.totalOpen : 0;
  const inFlight = flightR.ok
    ? flightR.value
    : {
        itemsInFlight: 0,
        oldestRunMinutes: null,
        activeRunCount: 0,
        lastHumanAttentionAt: null,
      };

  const inboxLoadFailed = !inboxR.ok;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {!inboxEnabled ? (
        <p className="mb-4 text-sm text-fg-muted">
          Inbox preview — enable flag <code>p6.inbox</code> for default landing.
        </p>
      ) : null}
      {inboxLoadFailed ? (
        <p className="mb-4 text-sm text-danger-fg" role="alert">
          Could not load inbox. Try refreshing the page.
        </p>
      ) : null}
      <InboxClient
        initialGroups={groups as never}
        totalOpen={totalOpen}
        inFlight={inFlight}
        projects={projects.map((p) => ({ id: p.id, key: p.key, name: p.name }))}
      />
    </div>
  );
}
