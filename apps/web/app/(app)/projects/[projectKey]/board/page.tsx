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
import {
  Badge,
  Button,
  complexityToTone,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  statusToTone,
} from '@nexus/ui';
import { notFound } from 'next/navigation';
import { TransitionWorkItemMenu } from '../../../../../src/components/TransitionWorkItemMenu';
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
    <div className="space-y-4">
      {canCreate ? (
        <Panel>
          <PanelBody>
            <form
              action={actionCreateWorkItem}
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="projectId" value={project.value.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <Field label="Quick create" className="min-w-[16rem] flex-1">
                <Input
                  name="title"
                  required
                  placeholder="New work item title"
                />
              </Field>
              <Field label="Complexity">
                <select
                  name="complexity"
                  defaultValue=""
                  className="flex h-[var(--nx-control-md)] rounded-md border border-border bg-surface px-2.5 text-sm"
                >
                  <option value="">—</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </Field>
              <Field label="Labels (comma keys)" className="min-w-[12rem]">
                <Input
                  name="labelKeys"
                  placeholder={labels
                    .slice(0, 2)
                    .map((l) => l.key)
                    .join(', ')}
                  className="font-mono text-xs"
                />
              </Field>
              <Button type="submit">Create</Button>
            </form>
          </PanelBody>
        </Panel>
      ) : (
        <p className="text-sm text-fg-subtle">
          Read-only access — mutations hidden.
        </p>
      )}

      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((stage) => {
          const columnItems = items.filter(
            (i) => i.currentStageId === stage.id,
          );
          return (
            <Panel key={stage.id} className="min-w-[16rem] flex-1 shrink-0">
              <PanelHeader className="sticky top-0 bg-surface z-10">
                <div>
                  <div className="text-sm font-medium">{stage.name}</div>
                  <div className="text-xs text-fg-subtle">
                    {columnItems.length} · {stage.defaultOwnerClass}
                    {stage.isTerminal ? ' · terminal' : ''}
                  </div>
                </div>
                <Badge tone="neutral">{columnItems.length}</Badge>
              </PanelHeader>
              <PanelBody className="space-y-2 p-2">
                {columnItems.map((item) => {
                  const status = deriveStatus({
                    archivedAt: item.archivedAt,
                    externallyBlockedReason: item.externallyBlockedReason,
                  });
                  const itemLabels = labelsByItem.get(item.id) ?? [];
                  return (
                    <Panel key={item.id} className="bg-surface-sunken">
                      <PanelBody className="p-3">
                        <Link
                          href={`/projects/${projectKey}/items/${item.key}`}
                          className="block"
                        >
                          <div className="font-mono text-[11px] text-fg-muted">
                            {item.key}
                          </div>
                          <div className="mt-1 text-sm leading-snug text-fg">
                            {item.title}
                          </div>
                        </Link>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {item.complexity ? (
                            <Badge tone={complexityToTone(item.complexity)}>
                              {item.complexity}
                            </Badge>
                          ) : null}
                          <Badge tone={statusToTone(status)}>{status}</Badge>
                          {itemLabels.map((l) => (
                            <Badge key={l.key} tone="neutral">{l.key}</Badge>
                          ))}
                        </div>
                        {canMove ? (
                          <TransitionWorkItemMenu
                            workItemId={item.id}
                            expectedVersion={item.version}
                            projectKey={projectKey}
                            itemKey={item.key}
                            currentStageId={stage.id}
                            stages={stages}
                            action={actionTransitionWorkItem}
                          />
                        ) : null}
                      </PanelBody>
                    </Panel>
                  );
                })}
                {columnItems.length === 0 ? (
                  <EmptyState title="Empty" className="py-6" />
                ) : null}
              </PanelBody>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
