import Link from 'next/link';
import {
  deriveWorkItemStatus,
  getLatestBlockingReasonsForItems,
  getProjectByKey,
  getProjectRole,
  listLabels,
  listReasonCodes,
  listStages,
  listWorkItems,
  loadActiveRunElapsed,
  can,
  parseProjectBudgetSettings,
  projectReworkStats,
  boardAttentionSummary,
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
  formatMicroUsdDisplay,
  CostSourceBadge,
  LiveDuration,
  LoopBadge,
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

  const [stagesResult, itemsResult, labelsResult, role, reasonCodesR, reworkR] =
    await Promise.all([
      listStages(ctx, project.value.id),
      listWorkItems(ctx, project.value.id),
      listLabels(ctx, project.value.id),
      getProjectRole(ctx, project.value.id),
      listReasonCodes(ctx, project.value.id),
      projectReworkStats(ctx, project.value.id, 30),
    ]);

  const stages = stagesResult.ok ? stagesResult.value : [];
  const items = itemsResult.ok ? itemsResult.value : [];
  const labels = labelsResult.ok ? labelsResult.value : [];
  const reasonCodes = (reasonCodesR.ok ? reasonCodesR.value : []).map((r) => ({
    code: r.code,
    label: r.label,
    requiresNote: r.requiresNote,
  }));
  const stagePos = new Map(stages.map((s) => [s.id, s.position]));
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

  const activeRuns = await loadActiveRunElapsed(ctx, itemIds);
  const statusByItem = new Map<string, string>();
  await Promise.all(
    items.map(async (item) => {
      const status = (await deriveWorkItemStatus(ctx, item.id)) ?? 'idle';
      statusByItem.set(item.id, status);
    }),
  );
  const blockedIds = items
    .filter((i) => {
      const s = statusByItem.get(i.id);
      return s === 'blocked_by_gate' || s === 'needs_approval';
    })
    .map((i) => i.id);
  const blockReasonByItem = await getLatestBlockingReasonsForItems(ctx, blockedIds);
  // eslint-disable-next-line react-hooks/purity -- SSR wall-clock snapshot for elapsed readout
  const _boardRenderedAtMs = Date.now();

  const budgetSettings = parseProjectBudgetSettings(
    project.value.settings as Record<string, unknown>,
  );

  let attentionSummary = {
    lanes: { needs_me: 0, ai_working: 0, blocked_external: 0, done: 0 },
    inboxOpen: 0,
    inFlight: {
      itemsInFlight: 0,
      oldestRunMinutes: null as number | null,
      activeRunCount: 0,
      lastHumanAttentionAt: null as Date | null,
    },
  };
  try {
    attentionSummary = await boardAttentionSummary(ctx, project.value.id);
  } catch {
    // Degrade: board still shows swimlane chrome if summary query fails.
  }

  return (
    <div className="space-y-4">
      <Panel>
        <PanelBody className="flex flex-wrap gap-4 text-sm">
          <div>
            <div className="font-medium">Needs me</div>
            <div className="text-lg">{attentionSummary.lanes.needs_me}</div>
          </div>
          <div>
            <div className="font-medium">AI working</div>
            <div className="text-lg">{attentionSummary.lanes.ai_working}</div>
          </div>
          <div>
            <div className="font-medium">Blocked externally</div>
            <div className="text-lg">{attentionSummary.lanes.blocked_external}</div>
          </div>
          <div>
            <div className="font-medium">Done</div>
            <div className="text-lg">{attentionSummary.lanes.done}</div>
          </div>
          <div className="ml-auto text-right text-fg-muted">
            Inbox open: {attentionSummary.inboxOpen} · in flight{' '}
            {attentionSummary.inFlight.itemsInFlight}
            {attentionSummary.inFlight.oldestRunMinutes != null
              ? ` · oldest run ${attentionSummary.inFlight.oldestRunMinutes}m`
              : ''}
          </div>
        </PanelBody>
      </Panel>
      {reworkR.ok ? (
        <Panel>
          <PanelBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <div className="font-medium">Rework rate (30d)</div>
              <div className="text-fg-muted text-xs">
                Share of items with at least one loop — process signal, not a
                people score.
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-medium">
                {Math.round(reworkR.value.reworkRate * 100)}%
              </div>
              <div className="text-xs text-fg-muted">
                {reworkR.value.loopedItemCount}/{reworkR.value.itemCount} items
              </div>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

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
                  const status = statusByItem.get(item.id) ?? 'idle';
                  const itemLabels = labelsByItem.get(item.id) ?? [];
                  const active = activeRuns.get(item.id);
                  const hard =
                    item.budgetMicroUsd ??
                    (item.complexity
                      ? budgetSettings.complexityDefaults[item.complexity]
                          .hardMicroUsd
                      : null);
                  const spent = item.spendMicroUsd ?? BigInt(0);
                  const spendWarn =
                    hard && hard > BigInt(0)
                      ? Number(spent) / Number(hard) >= 0.8
                      : false;
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
                            {item.title}{' '}
                            <LoopBadge
                              count={item.loopCount ?? 0}
                              escalated={item.loopEscalated ?? false}
                            />
                          </div>
                        </Link>
                        {active ? (
                          <div className="mt-1 text-[11px] text-accent">
                            AI working ·{' '}
                            <LiveDuration since={active.startedAt} />
                          </div>
                        ) : null}
                        <div className="mt-2 flex flex-wrap gap-1">
                          {item.complexity ? (
                            <Badge tone={complexityToTone(item.complexity)}>
                              {item.complexity}
                            </Badge>
                          ) : null}
                          <Badge tone={statusToTone(status)}>{status}</Badge>
                          {spendWarn ? (
                            <Badge tone="warning" title="Item spend past soft budget">
                              {formatMicroUsdDisplay(spent)}{' '}
                              <CostSourceBadge
                                source={item.spendSource ?? 'estimated'}
                                className="inline-flex"
                              />
                            </Badge>
                          ) : null}
                          {blockReasonByItem.has(item.id) ? (
                            <Badge
                              tone="blocked"
                              title={blockReasonByItem.get(item.id)}
                            >
                              blocked
                            </Badge>
                          ) : null}
                          {itemLabels.map((l) => (
                            <Badge key={l.key} tone="neutral">
                              {l.key}
                            </Badge>
                          ))}
                        </div>
                        {blockReasonByItem.has(item.id) ? (
                          <p className="mt-1 text-[11px] text-danger-fg line-clamp-2">
                            {blockReasonByItem.get(item.id)}
                          </p>
                        ) : null}
                        {canMove ? (
                          <TransitionWorkItemMenu
                            workItemId={item.id}
                            expectedVersion={item.version}
                            projectKey={projectKey}
                            itemKey={item.key}
                            currentStageId={stage.id}
                            currentStagePosition={stagePos.get(stage.id) ?? 0}
                            stages={stages.map((s) => ({
                              id: s.id,
                              name: s.name,
                              position: s.position,
                            }))}
                            reasonCodes={reasonCodes}
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
