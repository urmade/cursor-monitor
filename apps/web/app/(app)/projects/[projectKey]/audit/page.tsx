import { getProjectByKey, listProjectEvents } from '@nexus/core';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<{ type?: string; subject?: string }>;
}) {
  const { projectKey } = await params;
  const filters = await searchParams;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const eventsR = await listProjectEvents(ctx, project.value.id, {
    subjectId: filters.subject,
    limit: 200,
  });
  let events = eventsR.ok ? eventsR.value : [];
  if (filters.type) {
    events = events.filter((e) => e.type === filters.type);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Audit</h2>
        <p className="text-sm text-white/50">
          Reconstructed from the event outbox — no separate audit log.
        </p>
      </div>
      <form className="flex flex-wrap gap-2 text-sm">
        <input
          name="type"
          defaultValue={filters.type ?? ''}
          placeholder="type filter e.g. work_item.stage_changed"
          className="min-w-[16rem] flex-1 border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs"
        />
        <input
          name="subject"
          defaultValue={filters.subject ?? ''}
          placeholder="subject uuid"
          className="min-w-[16rem] flex-1 border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs"
        />
        <button
          type="submit"
          className="border border-white/20 px-3 py-2 text-xs hover:border-[var(--accent)]"
        >
          Filter
        </button>
      </form>
      <ul className="divide-y divide-white/5 border border-white/10">
        {events.map((e) => (
          <li key={e.id} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-[var(--accent)]">{e.type}</span>
              <span className="text-xs text-white/40">
                {e.occurredAt.toISOString()}
              </span>
            </div>
            <div className="mt-1 text-xs text-white/45">
              {e.subjectType}:{e.subjectId} · actor{' '}
              {JSON.stringify(e.actor)}
            </div>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-white/55">
              {JSON.stringify(e.payload, null, 2)}
            </pre>
          </li>
        ))}
        {events.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-white/40">
            No events match.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
