import Link from 'next/link';
import {
  can,
  deriveWorkItemStatus,
  getLatestGateResultsByGate,
  getLoopSummary,
  buildJourneyRibbonModel,
  listReasonCodes,
  getProjectByKey,
  getProjectRole,
  getWorkItemByKey,
  listArtifactRefs,
  listLabels,
  listPendingApprovalsForItem,
  listProjectEvents,
  listQuestions,
  listRunsForWorkItem,
  listSpecVersions,
  listStageInstances,
  listStageReports,
  listStages,
  listTransitions,
  listWarnings,
} from '@nexus/core';
import { eq } from 'drizzle-orm';
import { labels as labelsTable, workItemLabels } from '@nexus/db';
import {
  Badge,
  Button,
  CostSourceBadge,
  complexityToTone,
  Field,
  formatMicroUsdDisplay,
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
  LiveDuration,
  JourneyRibbon,
  LoopBadge,
} from '@nexus/ui';
import { notFound } from 'next/navigation';
import { ChecksPanel, WhyCantMove } from '../../../../../../src/components/ChecksPanel';
import { RunTimeline } from '../../../../../../src/components/RunTimeline';
import { TicketBudgetBar } from '../../../../../../src/components/TicketBudgetBar';
import { TransitionWorkItemMenu } from '../../../../../../src/components/TransitionWorkItemMenu';
import {
  actionAnswerQuestion,
  actionCancelRun,
  actionDecideApproval,
  actionDismissWarning,
  actionDryRunGates,
  actionLaunchRun,
  actionResumeBudgetItem,
  actionSaveSpec,
  actionSetItemBudget,
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
  const canProjectUpdate = can(ctx.actor, 'project.update', {
    type: 'project',
    projectId: project.value.id,
    role,
  });
  const canLaunch = can(ctx.actor, 'run.launch', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });
  const canCancel = can(ctx.actor, 'run.cancel', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });
  const canAnswer = can(ctx.actor, 'question.answer', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });

  const [
    stagesR,
    specsR,
    instances,
    transitions,
    eventsR,
    allLabelsR,
    runsR,
    reportsR,
    questionsR,
    artifactsR,
    warningsR,
    pendingApprovals,
    loopSummaryR,
    journeyR,
    reasonCodesR,
  ] = await Promise.all([
    listStages(ctx, project.value.id),
    listSpecVersions(ctx, item.id),
    listStageInstances(ctx, item.id),
    listTransitions(ctx, item.id),
    listProjectEvents(ctx, project.value.id, {
      workItemId: item.id,
      limit: 50,
    }),
    listLabels(ctx, project.value.id),
    listRunsForWorkItem(ctx, item.id),
    listStageReports(ctx, item.id),
    listQuestions(ctx, item.id),
    listArtifactRefs(ctx, item.id),
    listWarnings(ctx, item.id, { status: 'open' }),
    listPendingApprovalsForItem(ctx, item.id),
    getLoopSummary(ctx, item.id),
    buildJourneyRibbonModel(ctx, item.id),
    listReasonCodes(ctx, project.value.id),
  ]);

  const stages = stagesR.ok ? stagesR.value : [];
  const specs = specsR.ok ? specsR.value : [];
  const events = eventsR.ok ? eventsR.value : [];
  const allLabels = allLabelsR.ok ? allLabelsR.value : [];
  const runs = runsR.ok ? runsR.value : [];
  const reports = reportsR.ok ? reportsR.value : [];
  const qs = questionsR.ok ? questionsR.value.questions : [];
  const artifacts = artifactsR.ok ? artifactsR.value : [];
  const openWarnings = warningsR.ok ? warningsR.value : [];
  const latestByGate = await getLatestGateResultsByGate(ctx, item.id);
  const checks = [...latestByGate.values()].map((ev) => ({
    gateId: ev.gateId,
    gateName: ev.gateName || ev.gateId.slice(0, 8),
    outcome: ev.outcome,
    reason: ev.reason,
    evidence: ev.evidence as Record<string, unknown>,
    gateVersion: ev.gateVersion,
    gateConfig: ev.gateConfig,
  }));
  const approvalRows = pendingApprovals.map((a) => {
    const stored = [...latestByGate.values()].find((e) => e.gateId === a.gateId);
    const cfg = (stored?.gateConfig ?? {}) as { instructions?: string };
    return {
      id: a.id,
      gateId: a.gateId,
      gateName: stored?.gateName,
      status: a.status,
      instructions: cfg.instructions,
    };
  });
  const canOverride = can(ctx.actor, 'gate.override', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });
  const canDecide = can(ctx.actor, 'approval.decide', {
    type: 'work_item',
    projectId: project.value.id,
    role,
  });
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const reportByRun = new Map(reports.map((r) => [r.runId, r]));
  // eslint-disable-next-line react-hooks/purity -- SSR wall-clock snapshot for open-stage duration
  const _pageRenderedAtMs = Date.now();

  const currentLabels = await ctx.db
    .select({
      key: labelsTable.key,
      name: labelsTable.name,
    })
    .from(workItemLabels)
    .innerJoin(labelsTable, eq(labelsTable.id, workItemLabels.labelId))
    .where(eq(workItemLabels.workItemId, item.id));

  const status = (await deriveWorkItemStatus(ctx, item.id)) ?? 'idle';
  const currentSpec = specs[0];
  const prevSpec = specs[1];
  const specContent = currentSpec?.content as Record<string, unknown> | undefined;
  const openBlocking = qs.filter((q) => q.status === 'open' && q.blocking);

  const currentStageInstance = item.currentStageInstanceId
    ? instances.find((si) => si.id === item.currentStageInstanceId)
    : undefined;

  const runRows = runs.map((r) => {
    const report = reportByRun.get(r.id);
    return {
      id: r.id,
      status: r.status,
      outcome: r.outcome,
      durationMs: r.durationMs,
      tokens: r.tokens,
      providerUrl: r.providerUrl,
      errorCode: r.errorCode,
      errorDetail: r.errorDetail,
      createdAt: r.createdAt.toISOString(),
      costMicroUsd: r.costMicroUsd?.toString() ?? null,
      costSource: r.costSource ?? null,
      costEstimateMicroUsd: r.costEstimateMicroUsd?.toString() ?? null,
      report: report
        ? {
            headline: report.headline,
            summary: report.summary,
            outcome: report.outcome,
            confidence: report.confidence,
            assumptions: report.assumptions ?? [],
            notVerified: report.notVerified ?? [],
          }
        : null,
    };
  });

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
            {item.title}{' '}
            <LoopBadge
              count={item.loopCount ?? 0}
              escalated={item.loopEscalated ?? false}
            />
          </h2>
          <div className="mt-2">
            <TicketBudgetBar
              spentMicro={item.spendMicroUsd?.toString() ?? '0'}
              budgetMicro={item.budgetMicroUsd?.toString() ?? null}
              spendSource={item.spendSource ?? 'estimated'}
            />
            {(item.loopCount ?? 0) > 0 ? (
              <p className="mt-1 text-xs text-fg-muted">
                Rework (visits after the first):{' '}
                {formatMicroUsdDisplay(item.reworkCostMicroUsd ?? 0)}
                {item.reworkMs
                  ? ` · ${Math.round(Number(item.reworkMs) / 3_600_000)}h`
                  : ''}{' '}
                of {formatMicroUsdDisplay(item.spendMicroUsd ?? 0)} total
              </p>
            ) : null}
          </div>
          {item.pausedReason === 'budget' && canWrite ? (
            <form
              action={actionResumeBudgetItem}
              className="mt-3 grid max-w-md gap-2 rounded-md border border-border p-3"
            >
              <input type="hidden" name="workItemId" value={item.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <input type="hidden" name="itemKey" value={itemKey} />
              <p className="text-sm text-warning-fg">
                Item paused for budget. Raise the item budget or project cap, then resume.
              </p>
              <Field label="Resume reason">
                <Textarea name="reason" required rows={2} />
              </Field>
              <Button type="submit" size="sm" className="w-fit">
                Resume after budget fix
              </Button>
            </form>
          ) : null}
          {canProjectUpdate ? (
            <form
              action={actionSetItemBudget}
              className="mt-3 grid max-w-md gap-2 rounded-md border border-border p-3"
            >
              <input type="hidden" name="workItemId" value={item.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <input type="hidden" name="itemKey" value={itemKey} />
              <Field label="Override item hard budget (USD)">
                <Input name="budgetUsd" type="number" step="0.01" min="0" required />
              </Field>
              <Field label="Reason">
                <Textarea name="reason" required rows={2} />
              </Field>
              <Button type="submit" size="sm" variant="secondary" className="w-fit">
                Set item budget
              </Button>
            </form>
          ) : null}
        </div>

        {journeyR.ok ? (
          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Journey</span>
            </PanelHeader>
            <PanelBody>
              <JourneyRibbon
                nodes={journeyR.value.nodes.map((n) => ({
                  ...n,
                  costMicroUsd: n.costMicroUsd,
                }))}
                arcs={journeyR.value.arcs.map((a) => ({
                  loopEdgeId: a.loopEdgeId,
                  fromSeq: a.fromSeq,
                  toSeq: a.toSeq,
                  reasonCode: a.reasonCode,
                  costMicroUsd: a.costMicroUsd,
                  costComplete: a.costComplete,
                }))}
                collapsedPairs={journeyR.value.collapsedPairs}
                accessibleSummary={journeyR.value.accessibleSummary}
              />
            </PanelBody>
          </Panel>
        ) : null}

        {loopSummaryR.ok && loopSummaryR.value.edges.length > 0 ? (
          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Loops</span>
            </PanelHeader>
            <PanelBody>
              <ul className="space-y-2 text-sm">
                {loopSummaryR.value.edges.map((e) => (
                  <li key={e.id} className="border-b border-border pb-2 last:border-0">
                    <div className="font-medium">
                      {e.fromStageName} → {e.toStageName}
                    </div>
                    <div className="text-xs text-fg-muted">
                      {e.reasonCode}
                      {e.note ? ` — ${e.note}` : ''}
                      {' · '}
                      {e.trigger.kind}
                      {' · '}
                      {e.costMicroUsd != null
                        ? `${formatMicroUsdDisplay(e.costMicroUsd)}${e.costComplete ? '' : ' (provisional)'}`
                        : 'cost pending'}
                      {e.durationMs != null
                        ? ` · ${Math.round(Number(e.durationMs) / 60_000)}m`
                        : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        ) : null}

        {openBlocking.length > 0 ? (
          <Panel className="border-warning-border bg-warning-bg/30">
            <PanelHeader>
              <span className="text-sm font-medium text-warning-fg">
                Needs answer
              </span>
            </PanelHeader>
            <PanelBody className="space-y-4">
              {openBlocking.map((q) => (
                <div key={q.id} className="space-y-2">
                  <p className="text-sm text-fg">{q.text}</p>
                  {q.options.length > 0 ? (
                    <ul className="list-disc pl-4 text-xs text-fg-muted">
                      {q.options.map((o) => (
                        <li key={o}>{o}</li>
                      ))}
                    </ul>
                  ) : null}
                  {canAnswer ? (
                    <form action={actionAnswerQuestion} className="grid gap-2">
                      <input type="hidden" name="questionId" value={q.id} />
                      <input type="hidden" name="projectKey" value={projectKey} />
                      <input type="hidden" name="itemKey" value={itemKey} />
                      <Textarea name="answer" required rows={2} placeholder="Your answer" />
                      <Button type="submit" className="w-fit" size="sm">
                        Answer & resume
                      </Button>
                    </form>
                  ) : null}
                </div>
              ))}
            </PanelBody>
          </Panel>
        ) : null}

        <ChecksPanel
          checks={checks}
          warnings={openWarnings.map((w) => ({
            id: w.id,
            code: w.code,
            message: w.message,
            status: w.status,
          }))}
          approvals={approvalRows}
          canDecide={canDecide}
          canDismiss={canWrite}
          dismissAction={actionDismissWarning}
          decideAction={actionDecideApproval}
          projectKey={projectKey}
          itemKey={itemKey}
        />

        <WhyCantMove
          stages={stages.map((s) => ({ id: s.id, name: s.name }))}
          currentStageId={item.currentStageId}
          dryRunAction={actionDryRunGates}
          workItemId={item.id}
          projectKey={projectKey}
          itemKey={itemKey}
          expectedVersion={item.version}
          canOverride={canOverride}
          transitionAction={actionTransitionWorkItem}
        />

        <Panel>
          <PanelBody>
            <RunTimeline
              runs={runRows}
              workItemId={item.id}
              projectKey={projectKey}
              itemKey={itemKey}
              canLaunch={canLaunch}
              canCancel={canCancel}
              launchAction={actionLaunchRun}
              cancelAction={actionCancelRun}
            />
          </PanelBody>
        </Panel>

        {artifacts.length > 0 ? (
          <Panel>
            <PanelHeader>
              <span className="text-sm font-medium">Artifacts</span>
            </PanelHeader>
            <PanelBody>
              <ul className="space-y-1 text-sm">
                {artifacts.map((a) => (
                  <li key={a.id}>
                    <Badge tone="neutral">{a.kind}</Badge>{' '}
                    <a
                      href={a.url}
                      className="text-link hover:underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.title ?? a.url}
                    </a>
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        ) : null}

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
                            {inst.outcome ? ` · ${inst.outcome}` : ''}
                          </span>
                        </div>
                        <div className="text-xs text-fg-muted">
                          <LiveDuration
                            since={inst.enteredAt}
                            until={inst.exitedAt}
                            liveSuffix=" (open)"
                          />
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
              <TransitionWorkItemMenu
                workItemId={item.id}
                expectedVersion={item.version}
                projectKey={projectKey}
                itemKey={itemKey}
                currentStageId={item.currentStageId}
                currentStagePosition={
                  stageById.get(item.currentStageId)?.position ?? 0
                }
                stages={stages.map((s) => ({
                  id: s.id,
                  name: s.name,
                  position: s.position,
                }))}
                reasonCodes={(reasonCodesR.ok ? reasonCodesR.value : []).map(
                  (r) => ({
                    code: r.code,
                    label: r.label,
                    requiresNote: r.requiresNote,
                  }),
                )}
                action={actionTransitionWorkItem}
              />
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
          label="Stage spend"
          value={
            currentStageInstance ? (
              <span className="inline-flex items-center gap-1">
                {formatMicroUsdDisplay(currentStageInstance.costMicroUsd)}
                <CostSourceBadge
                  source={item.spendSource ?? 'estimated'}
                  className="inline-flex"
                />
              </span>
            ) : (
              '—'
            )
          }
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
