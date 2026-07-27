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
import {
  Badge,
  Button,
  complexityToTone,
  Field,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  PropertyRow,
  statusToTone,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@nexus/ui';
import { notFound } from 'next/navigation';
import {
  actionSaveSpec,
  actionTransitionWorkItem,
  actionUpdateWorkItem,
} from '../../../../../../src/server/actions';
import { requireSession } from '../../../../../../src/server/session';

export const dynamic = 'force-dynamic';

function specText(
  content: Record<string, unknown> | null | undefined,
  key: string,
): string {
  if (!content || typeof content[key] !== 'string') return '';
  return content[key] as string;
}

function specLines(
  content: Record<string, unknown> | null | undefined,
  key: string,
): string {
  if (!content || !Array.isArray(content[key])) return '';
  return (content[key] as string[]).join('\n');
}

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
  const specContent = currentSpec?.content as Record<string, unknown> | undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_14rem]">
      <div className="min-w-0 space-y-4">
        <div>
          <Link
            href={`/projects/${projectKey}/board`}
            className="text-xs text-fg-muted hover:text-link"
          >
            ← Board
          </Link>
          <div className="mt-2 font-mono text-xs text-fg-muted">{item.key}</div>
          <h2 className="text-xl font-medium tracking-tight text-fg">
            {item.title}
          </h2>
        </div>

        <Tabs defaultValue="spec">
          <TabsList>
            <TabsTrigger value="spec">Spec</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="spec">
            <Panel>
              <PanelHeader>
                <span className="text-sm font-medium">Spec</span>
              </PanelHeader>
              <PanelBody className="space-y-4">
                <p className="text-xs text-fg-subtle">
                  Write what matters. Acceptance criteria are optional.
                </p>
                {currentSpec ? (
                  <div className="space-y-3 text-sm">
                    <div className="text-xs text-fg-subtle">
                      Version {currentSpec.version}
                      {currentSpec.note ? ` · ${currentSpec.note}` : ''}
                    </div>
                    {specText(specContent, 'summary') ? (
                      <div>
                        <div className="text-xs text-fg-subtle">Summary</div>
                        <p className="mt-1 whitespace-pre-wrap">
                          {specText(specContent, 'summary')}
                        </p>
                      </div>
                    ) : null}
                    {specText(specContent, 'context') ? (
                      <div>
                        <div className="text-xs text-fg-subtle">Context</div>
                        <p className="mt-1 whitespace-pre-wrap">
                          {specText(specContent, 'context')}
                        </p>
                      </div>
                    ) : null}
                    {specText(specContent, 'approach') ? (
                      <div>
                        <div className="text-xs text-fg-subtle">Approach</div>
                        <p className="mt-1 whitespace-pre-wrap">
                          {specText(specContent, 'approach')}
                        </p>
                      </div>
                    ) : null}
                    {prevSpec ? (
                      <details className="text-xs text-fg-muted">
                        <summary className="cursor-pointer hover:text-fg">
                          Diff vs v{prevSpec.version}
                        </summary>
                        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-sunken p-2 text-xs">
                          {JSON.stringify(prevSpec.content, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">No spec yet.</p>
                )}

                {canSpec ? (
                  <form action={actionSaveSpec} className="grid gap-3 border-t border-border pt-4">
                    <input type="hidden" name="workItemId" value={item.id} />
                    <input type="hidden" name="projectKey" value={projectKey} />
                    <input type="hidden" name="itemKey" value={itemKey} />
                    <Field label="Summary">
                      <Textarea
                        name="summary"
                        required
                        rows={3}
                        defaultValue={specText(specContent, 'summary')}
                      />
                    </Field>
                    <Field label="Context">
                      <Textarea
                        name="context"
                        rows={2}
                        defaultValue={specText(specContent, 'context')}
                      />
                    </Field>
                    <Field label="Approach">
                      <Textarea
                        name="approach"
                        rows={2}
                        defaultValue={specText(specContent, 'approach')}
                      />
                    </Field>
                    <Field label="Open questions (one per line)">
                      <Textarea
                        name="openQuestions"
                        rows={2}
                        defaultValue={specLines(specContent, 'openQuestions')}
                      />
                    </Field>
                    <Field label="Version note">
                      <Input name="note" />
                    </Field>
                    <Button type="submit" className="w-fit">
                      Save new version
                    </Button>
                  </form>
                ) : null}
              </PanelBody>
            </Panel>
          </TabsContent>

          <TabsContent value="timeline">
            <Panel>
              <PanelHeader>
                <span className="text-sm font-medium">Stage timeline</span>
              </PanelHeader>
              <PanelBody>
                <ul className="space-y-2 text-sm">
                  {[...instances].reverse().map((inst) => {
                    const stage = stageById.get(inst.stageId);
                    const durationMs = inst.exitedAt
                      ? inst.exitedAt.getTime() - inst.enteredAt.getTime()
                      : Date.now() - inst.enteredAt.getTime();
                    return (
                      <li
                        key={inst.id}
                        className="flex flex-wrap justify-between gap-2 border-b border-border py-2"
                      >
                        <div>
                          <span className="font-medium">
                            {stage?.name ?? inst.stageId}
                          </span>
                          <span className="ml-2 text-xs text-fg-subtle">
                            seq {inst.seq}
                          </span>
                        </div>
                        <div className="text-xs text-fg-muted">
                          {Math.round(durationMs / 1000)}s
                          {inst.exitedAt ? '' : ' (open)'}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <h4 className="mt-4 text-xs uppercase tracking-wide text-fg-subtle">
                  Transitions
                </h4>
                <ul className="mt-2 space-y-1 text-xs text-fg-muted">
                  {[...transitions].reverse().map((t) => (
                    <li key={t.id}>
                      <Badge
                        tone={
                          t.direction === 'backward' ? 'backward' : 'forward'
                        }
                      >
                        {t.direction}
                      </Badge>
                      {stageById.get(t.fromStageId ?? '')?.name ?? '∅'} →{' '}
                      {stageById.get(t.toStageId)?.name}
                      {t.note ? ` · ${t.note}` : ''}
                    </li>
                  ))}
                </ul>
              </PanelBody>
            </Panel>
          </TabsContent>

          <TabsContent value="activity">
            <Panel>
              <PanelHeader>
                <span className="text-sm font-medium">Activity</span>
              </PanelHeader>
              <PanelBody>
                <ul className="space-y-2 text-xs">
                  {events.map((e) => (
                    <li
                      key={e.id}
                      className="border-b border-border py-2 text-fg-muted"
                    >
                      <span className="font-mono text-link">{e.type}</span>
                      <span className="ml-2">{e.occurredAt.toISOString()}</span>
                      <pre className="mt-1 whitespace-pre-wrap text-fg-subtle">
                        {JSON.stringify(e.payload)}
                      </pre>
                    </li>
                  ))}
                </ul>
              </PanelBody>
            </Panel>
          </TabsContent>
        </Tabs>

        {canWrite ? (
          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Details</span>
            </PanelHeader>
            <PanelBody>
              <form action={actionUpdateWorkItem} className="grid gap-3">
                <input type="hidden" name="workItemId" value={item.id} />
                <input type="hidden" name="expectedVersion" value={item.version} />
                <input type="hidden" name="projectKey" value={projectKey} />
                <input type="hidden" name="itemKey" value={itemKey} />
                <Field label="Title">
                  <Input name="title" defaultValue={item.title} />
                </Field>
                <Field label="Description">
                  <Textarea
                    name="description"
                    rows={3}
                    defaultValue={item.description}
                  />
                </Field>
                <Field label="Complexity">
                  <select
                    name="complexity"
                    defaultValue={item.complexity ?? ''}
                    className="flex h-[var(--nx-control-md)] w-full rounded-md border border-border bg-surface px-2.5 text-sm"
                  >
                    <option value="">—</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </Field>
                <Field label="Add labels (keys)">
                  <Input
                    name="addLabels"
                    placeholder={allLabels.map((l) => l.key).join(', ')}
                    className="font-mono text-xs"
                  />
                </Field>
                <Button type="submit" className="w-fit">Save</Button>
              </form>
            </PanelBody>
          </Panel>
        ) : null}

        {canMove ? (
          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Move stage</span>
            </PanelHeader>
            <PanelBody>
              <form
                action={actionTransitionWorkItem}
                className="flex flex-wrap gap-2"
              >
                <input type="hidden" name="workItemId" value={item.id} />
                <input type="hidden" name="expectedVersion" value={item.version} />
                <input type="hidden" name="projectKey" value={projectKey} />
                <input type="hidden" name="itemKey" value={itemKey} />
                <select
                  name="toStageId"
                  defaultValue=""
                  className="rounded-md border border-border bg-surface px-2.5 py-2 text-sm"
                >
                  <option value="" disabled>Select stage…</option>
                  {stages
                    .filter((s) => s.id !== item.currentStageId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                </select>
                <Input name="note" placeholder="Optional note" className="max-w-xs" />
                <Button type="submit">Transition</Button>
              </form>
            </PanelBody>
          </Panel>
        ) : null}
      </div>

      <aside className="space-y-1 border-l border-border pl-4">
        <PropertyRow
          label="Status"
          value={<Badge tone={statusToTone(status)}>{status}</Badge>}
        />
        <PropertyRow
          label="Complexity"
          value={
            item.complexity ? (
              <Badge tone={complexityToTone(item.complexity)}>
                {item.complexity}
              </Badge>
            ) : (
              '—'
            )
          }
        />
        <PropertyRow
          label="Stage"
          value={stageById.get(item.currentStageId)?.name ?? '—'}
        />
        <PropertyRow
          label="Labels"
          value={
            <div className="flex flex-wrap gap-1">
              {currentLabels.length === 0
                ? '—'
                : currentLabels.map((l) => (
                    <Badge key={l.key} tone="neutral">{l.key}</Badge>
                  ))}
            </div>
          }
        />
      </aside>
    </div>
  );
}
