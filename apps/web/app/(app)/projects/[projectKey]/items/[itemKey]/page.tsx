import Link from 'next/link';
import {
  can,
  deriveStatus,
  getProjectByKey,
  getProjectRole,
  getWorkItemByKey,
  listLabels,
  listProjectEvents,
  listSpecVersions,
  listStageInstances,
  listStages,
  listTransitions,
} from '@nexus/core';
import { eq } from 'drizzle-orm';
import { labels as labelsTable, workItemLabels } from '@nexus/db';
import { notFound } from 'next/navigation';
import {
  actionSaveSpec,
  actionTransitionWorkItem,
  actionUpdateWorkItem,
} from '../../../../../../src/server/actions';
import { requireSession } from '../../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function ItemPage({
  params,
}: {
  params: Promise<{ projectKey: string; itemKey: string }>;
}) {
  const { projectKey, itemKey } = await params;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const itemResult = await getWorkItemByKey(ctx, project.value.id, itemKey);
  if (!itemResult.ok) notFound();
  const item = itemResult.value;

  const role = await getProjectRole(ctx, project.value.id);
  const canWrite = can(ctx.actor, 'work_item.update', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });
  const canSpec = can(ctx.actor, 'spec.write', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });
  const canMove = can(ctx.actor, 'work_item.transition', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });

  const [stagesR, specsR, instances, transitions, eventsR, allLabelsR] =
    await Promise.all([
      listStages(ctx, project.value.id),
      listSpecVersions(ctx, item.id),
      listStageInstances(ctx, item.id),
      listTransitions(ctx, item.id),
      listProjectEvents(ctx, project.value.id, {
        workItemId: item.id,
        limit: 50,
      }),
      listLabels(ctx, project.value.id),
    ]);

  const stages = stagesR.ok ? stagesR.value : [];
  const specs = specsR.ok ? specsR.value : [];
  const events = eventsR.ok ? eventsR.value : [];
  const allLabels = allLabelsR.ok ? allLabelsR.value : [];
  const stageById = new Map(stages.map((s) => [s.id, s]));

  const currentLabels = await ctx.db
    .select({
      key: labelsTable.key,
      name: labelsTable.name,
    })
    .from(workItemLabels)
    .innerJoin(labelsTable, eq(labelsTable.id, workItemLabels.labelId))
    .where(eq(workItemLabels.workItemId, item.id));

  const status = deriveStatus({
    archivedAt: item.archivedAt,
    externallyBlockedReason: item.externallyBlockedReason,
  });
  const currentSpec = specs[0];
  const prevSpec = specs[1];

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/projects/${projectKey}/board`}
          className="text-sm text-white/50 hover:text-[var(--accent)]"
        >
          ← Board
        </Link>
        <div className="mt-2 font-mono text-xs text-[var(--accent)]">{item.key}</div>
        <h2 className="font-[family-name:var(--font-display)] text-3xl tracking-tight">
          {item.title}
        </h2>
        <div className="mt-2 flex flex-wrap gap-2 text-xs uppercase tracking-wide text-white/50">
          <span className="border border-white/15 px-2 py-0.5">{status}</span>
          <span className="border border-white/15 px-2 py-0.5">
            {item.complexity ?? 'no complexity'}
          </span>
          <span className="border border-white/15 px-2 py-0.5">
            {stageById.get(item.currentStageId)?.name ?? 'stage'}
          </span>
          {currentLabels.map((l) => (
            <span key={l.key} className="border border-white/15 px-2 py-0.5">
              {l.key}
            </span>
          ))}
        </div>
      </div>

      {canWrite ? (
        <section className="border border-white/10 p-4">
          <h3 className="text-sm font-medium text-white/70">Details</h3>
          <form action={actionUpdateWorkItem} className="mt-3 grid gap-3">
            <input type="hidden" name="workItemId" value={item.id} />
            <input type="hidden" name="expectedVersion" value={item.version} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <input type="hidden" name="itemKey" value={itemKey} />
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Title</span>
              <input
                name="title"
                defaultValue={item.title}
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Description</span>
              <textarea
                name="description"
                rows={3}
                defaultValue={item.description}
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Complexity</span>
              <select
                name="complexity"
                defaultValue={item.complexity ?? ''}
                className="border border-white/15 bg-black/30 px-3 py-2"
              >
                <option value="">—</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Add labels (keys)</span>
              <input
                name="addLabels"
                placeholder={allLabels.map((l) => l.key).join(', ')}
                className="border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs"
              />
            </label>
            <button
              type="submit"
              className="w-fit bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--ink)]"
            >
              Save
            </button>
          </form>
        </section>
      ) : null}

      {canMove ? (
        <section className="border border-white/10 p-4">
          <h3 className="text-sm font-medium text-white/70">Move stage</h3>
          <form
            action={actionTransitionWorkItem}
            className="mt-3 flex flex-wrap gap-2"
          >
            <input type="hidden" name="workItemId" value={item.id} />
            <input type="hidden" name="expectedVersion" value={item.version} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <input type="hidden" name="itemKey" value={itemKey} />
            <select
              name="toStageId"
              className="border border-white/15 bg-black/30 px-3 py-2 text-sm"
              defaultValue=""
            >
              <option value="" disabled>
                Select stage…
              </option>
              {stages
                .filter((s) => s.id !== item.currentStageId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <input
              name="note"
              placeholder="Optional note"
              className="border border-white/15 bg-black/30 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--ink)]"
            >
              Transition
            </button>
          </form>
        </section>
      ) : null}

      <section className="border border-white/10 p-4">
        <h3 className="text-sm font-medium text-white/70">Spec</h3>
        <p className="mt-1 text-xs text-white/40">
          Write what matters. Acceptance criteria are optional and only prompted
          when a project opts in.
        </p>
        {currentSpec ? (
          <div className="mt-3 space-y-2 text-sm">
            <div className="text-xs text-white/45">
              Version {currentSpec.version}
              {currentSpec.note ? ` · ${currentSpec.note}` : ''}
            </div>
            <pre className="whitespace-pre-wrap border border-white/10 bg-black/30 p-3 text-sm">
              {JSON.stringify(currentSpec.content, null, 2)}
            </pre>
            {prevSpec ? (
              <details className="text-xs text-white/55">
                <summary className="cursor-pointer hover:text-white">
                  Diff vs v{prevSpec.version}
                </summary>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <pre className="whitespace-pre-wrap border border-white/10 p-2">
                    {JSON.stringify(prevSpec.content, null, 2)}
                  </pre>
                  <pre className="whitespace-pre-wrap border border-white/10 p-2">
                    {JSON.stringify(currentSpec.content, null, 2)}
                  </pre>
                </div>
              </details>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-white/45">No spec yet.</p>
        )}

        {canSpec ? (
          <form action={actionSaveSpec} className="mt-4 grid gap-3">
            <input type="hidden" name="workItemId" value={item.id} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <input type="hidden" name="itemKey" value={itemKey} />
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Summary</span>
              <textarea
                name="summary"
                required
                rows={3}
                defaultValue={
                  typeof currentSpec?.content?.summary === 'string'
                    ? currentSpec.content.summary
                    : ''
                }
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Context</span>
              <textarea
                name="context"
                rows={2}
                defaultValue={
                  typeof currentSpec?.content?.context === 'string'
                    ? currentSpec.content.context
                    : ''
                }
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Approach</span>
              <textarea
                name="approach"
                rows={2}
                defaultValue={
                  typeof currentSpec?.content?.approach === 'string'
                    ? currentSpec.content.approach
                    : ''
                }
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Open questions (one per line)</span>
              <textarea
                name="openQuestions"
                rows={2}
                defaultValue={
                  Array.isArray(currentSpec?.content?.openQuestions)
                    ? (currentSpec.content.openQuestions as string[]).join('\n')
                    : ''
                }
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Version note</span>
              <input
                name="note"
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <button
              type="submit"
              className="w-fit bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--ink)]"
            >
              Save new version
            </button>
          </form>
        ) : null}

        {specs.length > 1 ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-white/50">
              Version history ({specs.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-white/55">
              {specs.map((s) => (
                <li key={s.id}>
                  v{s.version} · {s.createdAt.toISOString()}
                  {s.note ? ` · ${s.note}` : ''}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="border border-white/10 p-4">
        <h3 className="text-sm font-medium text-white/70">Stage timeline</h3>
        <ul className="mt-3 space-y-2 text-sm">
          {[...instances].reverse().map((inst) => {
            const stage = stageById.get(inst.stageId);
            const durationMs = inst.exitedAt
              ? inst.exitedAt.getTime() - inst.enteredAt.getTime()
              : Date.now() - inst.enteredAt.getTime();
            return (
              <li
                key={inst.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/5 py-2"
              >
                <div>
                  <span className="font-medium">{stage?.name ?? inst.stageId}</span>
                  <span className="ml-2 text-xs text-white/40">seq {inst.seq}</span>
                </div>
                <div className="text-xs text-white/45">
                  {Math.round(durationMs / 1000)}s
                  {inst.exitedAt ? '' : ' (open)'}
                </div>
              </li>
            );
          })}
        </ul>
        <h4 className="mt-4 text-xs uppercase tracking-wide text-white/40">
          Transitions
        </h4>
        <ul className="mt-2 space-y-1 text-xs text-white/55">
          {[...transitions].reverse().map((t) => (
            <li key={t.id}>
              {t.direction}: {stageById.get(t.fromStageId ?? '')?.name ?? '∅'} →{' '}
              {stageById.get(t.toStageId)?.name}
              {t.note ? ` · ${t.note}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section className="border border-white/10 p-4">
        <h3 className="text-sm font-medium text-white/70">Activity</h3>
        <ul className="mt-3 space-y-2 text-xs">
          {events.map((e) => (
            <li key={e.id} className="border-b border-white/5 py-2 text-white/60">
              <span className="font-mono text-[var(--accent)]/80">{e.type}</span>
              <span className="ml-2">{e.occurredAt.toISOString()}</span>
              <pre className="mt-1 whitespace-pre-wrap text-white/40">
                {JSON.stringify(e.payload)}
              </pre>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
