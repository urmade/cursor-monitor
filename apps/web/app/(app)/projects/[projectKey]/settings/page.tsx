import {
  can,
  getProjectByKey,
  getProjectRole,
  listLabels,
  listStages,
} from '@nexus/core';
import { notFound } from 'next/navigation';
import {
  actionAddStage,
  actionRenameStage,
  actionUpdateProject,
  actionUpsertLabel,
} from '../../../../../src/server/actions';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const role = await getProjectRole(ctx, project.value.id);
  const canPipeline = can(ctx.actor, 'project.manage_pipeline', {
    type: 'project',
    projectId: project.value.id,
    role,
  });
  const canLabels = can(ctx.actor, 'project.manage_labels', {
    type: 'project',
    projectId: project.value.id,
    role,
  });
  const canUpdate = can(ctx.actor, 'project.update', {
    type: 'project',
    projectId: project.value.id,
    role,
  });

  const [stagesR, labelsR] = await Promise.all([
    listStages(ctx, project.value.id),
    listLabels(ctx, project.value.id),
  ]);
  const stages = stagesR.ok ? stagesR.value : [];
  const labels = labelsR.ok ? labelsR.value : [];

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="border border-white/10 p-4">
        <h2 className="text-lg font-medium">Project</h2>
        {canUpdate ? (
          <form action={actionUpdateProject} className="mt-3 grid gap-3">
            <input type="hidden" name="projectId" value={project.value.id} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Name</span>
              <input
                name="name"
                defaultValue={project.value.name}
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/55">Description</span>
              <textarea
                name="description"
                rows={2}
                defaultValue={project.value.description}
                className="border border-white/15 bg-black/30 px-3 py-2"
              />
            </label>
            <button
              type="submit"
              className="w-fit bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--ink)]"
            >
              Save
            </button>
          </form>
        ) : (
          <p className="mt-2 text-sm text-white/50">{project.value.description}</p>
        )}
        <p className="mt-4 text-xs text-white/40">Your role: {role ?? 'none'}</p>
      </section>

      <section className="border border-white/10 p-4">
        <h2 className="text-lg font-medium">Pipeline</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {stages.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 py-2"
            >
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="font-mono text-[11px] text-white/40">
                  {s.key} · pos {s.position}
                  {s.isInitial ? ' · initial' : ''}
                  {s.isTerminal ? ' · terminal' : ''}
                </div>
              </div>
              {canPipeline ? (
                <form action={actionRenameStage} className="flex gap-1">
                  <input type="hidden" name="stageId" value={s.id} />
                  <input type="hidden" name="projectKey" value={projectKey} />
                  <input
                    name="name"
                    defaultValue={s.name}
                    className="w-36 border border-white/15 bg-black/30 px-2 py-1 text-xs"
                  />
                  <button
                    type="submit"
                    className="border border-white/20 px-2 py-1 text-xs"
                  >
                    Rename
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {canPipeline ? (
          <form action={actionAddStage} className="mt-4 grid gap-2 border-t border-white/10 pt-4">
            <input type="hidden" name="projectId" value={project.value.id} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <div className="text-xs text-white/50">Add stage</div>
            <input
              name="key"
              required
              placeholder="key"
              className="border border-white/15 bg-black/30 px-2 py-1 font-mono text-xs"
            />
            <input
              name="name"
              required
              placeholder="Name"
              className="border border-white/15 bg-black/30 px-2 py-1 text-sm"
            />
            <input
              name="position"
              type="number"
              defaultValue={stages.length ? stages[stages.length - 1]!.position + 50 : 100}
              className="border border-white/15 bg-black/30 px-2 py-1 text-sm"
            />
            <select
              name="defaultOwnerClass"
              defaultValue="human"
              className="border border-white/15 bg-black/30 px-2 py-1 text-sm"
            >
              <option value="human">human</option>
              <option value="ai">ai</option>
              <option value="external">external</option>
            </select>
            <label className="flex items-center gap-2 text-xs text-white/55">
              <input type="checkbox" name="isTerminal" /> terminal
            </label>
            <button
              type="submit"
              className="w-fit bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--ink)]"
            >
              Add stage
            </button>
          </form>
        ) : null}
      </section>

      <section className="border border-white/10 p-4 lg:col-span-2">
        <h2 className="text-lg font-medium">Labels</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {labels.map((l) => (
            <span
              key={l.id}
              className="border border-white/15 px-2 py-1 text-xs"
              title={l.category ?? undefined}
            >
              <span className="font-mono text-[var(--accent)]/80">{l.key}</span>
              <span className="ml-2 text-white/60">{l.name}</span>
            </span>
          ))}
        </div>
        {canLabels ? (
          <form
            action={actionUpsertLabel}
            className="mt-4 grid max-w-md gap-2 border-t border-white/10 pt-4"
          >
            <input type="hidden" name="projectId" value={project.value.id} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <div className="text-xs text-white/50">Upsert label</div>
            <input
              name="key"
              required
              placeholder="category:value"
              className="border border-white/15 bg-black/30 px-2 py-1 font-mono text-xs"
            />
            <input
              name="name"
              required
              placeholder="Display name"
              className="border border-white/15 bg-black/30 px-2 py-1 text-sm"
            />
            <input
              name="category"
              placeholder="category"
              className="border border-white/15 bg-black/30 px-2 py-1 text-sm"
            />
            <input
              name="color"
              defaultValue="gray"
              className="border border-white/15 bg-black/30 px-2 py-1 text-sm"
            />
            <button
              type="submit"
              className="w-fit bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--ink)]"
            >
              Save label
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
