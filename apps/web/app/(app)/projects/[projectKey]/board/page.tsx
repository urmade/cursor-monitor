import Link from 'next/link';
import {
  deriveStatus,
  getProjectByKey,
  getProjectRole,
  listLabels,
  listStages,
  listWorkItems,
  can,
} from '@nexus/core';
import { eq, inArray } from 'drizzle-orm';
import { workItemLabels, labels as labelsTable } from '@nexus/db';
import { notFound } from 'next/navigation';
import {
  actionCreateWorkItem,
  actionTransitionWorkItem,
} from '../../../../../src/server/actions';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function BoardPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const [stagesResult, itemsResult, labelsResult, role] = await Promise.all([
    listStages(ctx, project.value.id),
    listWorkItems(ctx, project.value.id),
    listLabels(ctx, project.value.id),
    getProjectRole(ctx, project.value.id),
  ]);

  const stages = stagesResult.ok ? stagesResult.value : [];
  const items = itemsResult.ok ? itemsResult.value : [];
  const labels = labelsResult.ok ? labelsResult.value : [];
  const canCreate = can(ctx.actor, 'work_item.create', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });
  const canMove = can(ctx.actor, 'work_item.transition', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });

  const itemIds = items.map((i) => i.id);
  const labelRows =
    itemIds.length === 0
      ? []
      : await ctx.db
          .select({
            workItemId: workItemLabels.workItemId,
            key: labelsTable.key,
            name: labelsTable.name,
            color: labelsTable.color,
          })
          .from(workItemLabels)
          .innerJoin(labelsTable, eq(labelsTable.id, workItemLabels.labelId))
          .where(inArray(workItemLabels.workItemId, itemIds));

  const labelsByItem = new Map<string, typeof labelRows>();
  for (const row of labelRows) {
    const list = labelsByItem.get(row.workItemId) ?? [];
    list.push(row);
    labelsByItem.set(row.workItemId, list);
  }

  return (
    <div className="space-y-6">
      {canCreate ? (
        <form
          action={actionCreateWorkItem}
          className="flex flex-wrap items-end gap-3 border border-white/10 bg-white/[0.02] p-4"
        >
          <input type="hidden" name="projectId" value={project.value.id} />
          <input type="hidden" name="projectKey" value={projectKey} />
          <label className="grid min-w-[16rem] flex-1 gap-1 text-sm">
            <span className="text-white/55">Quick create</span>
            <input
              name="title"
              required
              placeholder="New work item title"
              className="border border-white/15 bg-black/30 px-3 py-2 outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-white/55">Complexity</span>
            <select
              name="complexity"
              className="border border-white/15 bg-black/30 px-3 py-2"
              defaultValue=""
            >
              <option value="">—</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="grid min-w-[12rem] gap-1 text-sm">
            <span className="text-white/55">Labels (comma keys)</span>
            <input
              name="labelKeys"
              placeholder={labels
                .slice(0, 2)
                .map((l) => l.key)
                .join(', ')}
              className="border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs"
            />
          </label>
          <button
            type="submit"
            className="bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--ink)]"
          >
            Create
          </button>
        </form>
      ) : (
        <p className="text-sm text-white/45">Read-only access — mutations hidden.</p>
      )}

      <div className="flex gap-3 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const columnItems = items.filter((i) => i.currentStageId === stage.id);
          return (
            <section
              key={stage.id}
              className="min-w-[16rem] flex-1 border border-white/10 bg-black/20"
            >
              <header className="border-b border-white/10 px-3 py-2">
                <div className="text-sm font-medium">{stage.name}</div>
                <div className="text-xs text-white/40">
                  {columnItems.length} · {stage.defaultOwnerClass}
                  {stage.isTerminal ? ' · terminal' : ''}
                </div>
              </header>
              <div className="space-y-2 p-2">
                {columnItems.map((item) => {
                  const status = deriveStatus({
                    archivedAt: item.archivedAt,
                    externallyBlockedReason: item.externallyBlockedReason,
                  });
                  const itemLabels = labelsByItem.get(item.id) ?? [];
                  return (
                    <article
                      key={item.id}
                      className="border border-white/10 bg-white/[0.03] p-3"
                    >
                      <Link
                        href={`/projects/${projectKey}/items/${item.key}`}
                        className="block"
                      >
                        <div className="font-mono text-[11px] text-[var(--accent)]">
                          {item.key}
                        </div>
                        <div className="mt-1 text-sm leading-snug">{item.title}</div>
                      </Link>
                      <div className="mt-2 flex flex-wrap gap-1 text-[10px] uppercase tracking-wide text-white/50">
                        {item.complexity ? (
                          <span className="border border-white/15 px-1.5 py-0.5">
                            {item.complexity}
                          </span>
                        ) : null}
                        <span className="border border-white/15 px-1.5 py-0.5">
                          {status}
                        </span>
                        {itemLabels.map((l) => (
                          <span
                            key={l.key}
                            className="border border-white/15 px-1.5 py-0.5"
                          >
                            {l.key}
                          </span>
                        ))}
                      </div>
                      {canMove ? (
                        <form
                          action={actionTransitionWorkItem}
                          className="mt-3 flex gap-1"
                        >
                          <input type="hidden" name="workItemId" value={item.id} />
                          <input
                            type="hidden"
                            name="expectedVersion"
                            value={item.version}
                          />
                          <input type="hidden" name="projectKey" value={projectKey} />
                          <input type="hidden" name="itemKey" value={item.key} />
                          <select
                            name="toStageId"
                            defaultValue=""
                            className="min-w-0 flex-1 border border-white/15 bg-black/40 px-2 py-1 text-xs"
                          >
                            <option value="" disabled>
                              Move to…
                            </option>
                            {stages
                              .filter((s) => s.id !== stage.id)
                              .map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                          </select>
                          <button
                            type="submit"
                            className="border border-white/20 px-2 py-1 text-xs hover:border-[var(--accent)]"
                          >
                            Go
                          </button>
                        </form>
                      ) : null}
                    </article>
                  );
                })}
                {columnItems.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-white/30">
                    Empty
                  </p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
