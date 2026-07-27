import {
  can,
  getProjectByKey,
  getProjectRole,
  listLabels,
  listStages,
} from '@nexus/core';
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  Textarea,
} from '@nexus/ui';
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

  const inputClass =
    'flex h-[var(--nx-control-md)] w-full rounded-md border border-border bg-surface px-2.5 text-sm';

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel>
        <PanelHeader>
          <span className="text-sm font-medium">Project</span>
        </PanelHeader>
        <PanelBody>
          {canUpdate ? (
            <form action={actionUpdateProject} className="grid gap-3">
              <input type="hidden" name="projectId" value={project.value.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <Field label="Name">
                <Input name="name" defaultValue={project.value.name} />
              </Field>
              <Field label="Description">
                <Textarea
                  name="description"
                  rows={2}
                  defaultValue={project.value.description}
                />
              </Field>
              <Button type="submit" className="w-fit">Save</Button>
            </form>
          ) : (
            <p className="text-sm text-fg-muted">{project.value.description}</p>
          )}
          <p className="mt-4 text-xs text-fg-subtle">Your role: {role ?? 'none'}</p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <span className="text-sm font-medium">Pipeline</span>
        </PanelHeader>
        <PanelBody>
          <ul className="space-y-2 text-sm">
            {stages.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2"
              >
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="font-mono text-[11px] text-fg-subtle">
                    {s.key} · pos {s.position}
                    {s.isInitial ? ' · initial' : ''}
                    {s.isTerminal ? ' · terminal' : ''}
                  </div>
                </div>
                {canPipeline ? (
                  <form action={actionRenameStage} className="flex gap-1">
                    <input type="hidden" name="stageId" value={s.id} />
                    <input type="hidden" name="projectKey" value={projectKey} />
                    <Input
                      name="name"
                      defaultValue={s.name}
                      className="w-36 text-xs"
                    />
                    <Button type="submit" variant="secondary" size="sm">
                      Rename
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {canPipeline ? (
            <form
              action={actionAddStage}
              className="mt-4 grid gap-2 border-t border-border pt-4"
            >
              <input type="hidden" name="projectId" value={project.value.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <div className="text-xs text-fg-subtle">Add stage</div>
              <Input name="key" required placeholder="key" className="font-mono text-xs" />
              <Input name="name" required placeholder="Name" />
              <Input
                name="position"
                type="number"
                defaultValue={
                  stages.length ? stages[stages.length - 1]!.position + 50 : 100
                }
              />
              <select
                name="defaultOwnerClass"
                defaultValue="human"
                className={inputClass}
              >
                <option value="human">human</option>
                <option value="ai">ai</option>
                <option value="external">external</option>
              </select>
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <input type="checkbox" name="isTerminal" /> terminal
              </label>
              <Button type="submit" className="w-fit">Add stage</Button>
            </form>
          ) : null}
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-2">
        <PanelHeader>
          <span className="text-sm font-medium">Labels</span>
        </PanelHeader>
        <PanelBody>
          <div className="flex flex-wrap gap-2">
            {labels.map((l) => (
              <Badge key={l.id} tone="neutral" title={l.category ?? undefined}>
                <span className="font-mono">{l.key}</span>
                <span className="ml-2 normal-case">{l.name}</span>
              </Badge>
            ))}
          </div>
          {canLabels ? (
            <form
              action={actionUpsertLabel}
              className="mt-4 grid max-w-md gap-2 border-t border-border pt-4"
            >
              <input type="hidden" name="projectId" value={project.value.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <div className="text-xs text-fg-subtle">Upsert label</div>
              <Input
                name="key"
                required
                placeholder="category:value"
                className="font-mono text-xs"
              />
              <Input name="name" required placeholder="Display name" />
              <Input name="category" placeholder="category" />
              <Input name="color" defaultValue="gray" />
              <Button type="submit" className="w-fit">Save label</Button>
            </form>
          ) : null}
        </PanelBody>
      </Panel>
    </div>
  );
}
