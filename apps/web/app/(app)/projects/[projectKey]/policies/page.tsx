import {
  can,
  describeCondition,
  describeRubric,
  getProjectByKey,
  getProjectRole,
  isAcceptanceCriteriaEnabled,
  listBindings,
  listGates,
  listPendingApprovals,
  listRubrics,
  listStages,
  listWorkItems,
  previewGates,
  SEEDED_RUBRIC_TEMPLATES,
} from '@nexus/core';
import type { ConditionAst, GateTrigger } from '@nexus/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@nexus/ui';
import { notFound } from 'next/navigation';
import {
  actionArchiveGate,
  actionCreateGate,
  actionCreateRubric,
  actionEnableGate,
  actionEnableRubric,
  actionRunGoldenSet,
  actionSetEnforcementMode,
} from '../../../../../src/server/actions';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function PoliciesPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const role = await getProjectRole(ctx, project.value.id);
  const canManage = can(ctx.actor, 'project.manage_gates', {
    type: 'project',
    projectId: project.value.id,
    role,
  });

  const [gatesR, stagesR, bindingsR, itemsR, pendingR, rubricsR] =
    await Promise.all([
      listGates(ctx, project.value.id),
      listStages(ctx, project.value.id),
      listBindings(ctx, project.value.id),
      listWorkItems(ctx, project.value.id),
      listPendingApprovals(ctx, { projectId: project.value.id }),
      listRubrics(ctx, project.value.id),
    ]);

  const gates = gatesR.ok ? gatesR.value : [];
  const stages = stagesR.ok ? stagesR.value : [];
  const bindings = bindingsR.ok ? bindingsR.value : [];
  const items = itemsR.ok ? itemsR.value.slice(0, 40) : [];
  const pending = pendingR.ok ? pendingR.value : [];
  const rubrics = rubricsR.ok ? rubricsR.value : [];
  const acEnabled = isAcceptanceCriteriaEnabled(project.value.optionalConcepts);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const settings = (project.value.settings ?? {}) as Record<string, unknown>;
  const enforcementMode =
    settings.enforcement_mode === 'observe' ? 'observe' : 'enforce';

  // Live preview: one context build per item, reused across all enabled gates.
  const enabledGates = gates.filter((x) => x.enabled).slice(0, 12);
  const previews: Record<
    string,
    Array<{ workItemId: string; key?: string; outcome: string; reason: string }>
  > = {};
  if (enabledGates.length > 0 && items.length > 0) {
    const batch = await previewGates(ctx, {
      projectId: project.value.id,
      gates: enabledGates.map((g) => ({
        id: g.id,
        evaluator: g.evaluator,
        trigger: g.trigger as GateTrigger,
        appliesWhen: g.appliesWhen,
        config: g.config as Record<string, unknown>,
        onFailure: g.onFailure,
        name: g.name,
      })),
      workItemIds: items.map((i) => i.id),
    });
    if (batch.ok) {
      const keyById = new Map(items.map((i) => [i.id, i.key]));
      for (const [gateId, rows] of Object.entries(batch.value)) {
        previews[gateId] = rows.map((p) => ({
          ...p,
          key: keyById.get(p.workItemId),
        }));
      }
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      <div>
        <h2 className="text-lg font-medium text-fg">Policy Studio</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Define gates and review bindings in one place. The board stays a runtime
          view — configuration lives here so Phase 4 budgets and Phase 7 rubrics
          have room to grow.
        </p>
      </div>

      <Panel>
        <PanelHeader>
          <span className="text-sm font-medium">Enforcement</span>
        </PanelHeader>
        <PanelBody>
          <form action={actionSetEnforcementMode} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="projectId" value={project.value.id} />
            <input type="hidden" name="projectKey" value={projectKey} />
            <Field label="Mode">
              <select
                name="enforcement_mode"
                defaultValue={enforcementMode}
                className="h-9 rounded border border-border bg-surface px-2 text-sm"
              >
                <option value="enforce">enforce — gates can block</option>
                <option value="observe">observe — evaluate &amp; record only</option>
              </select>
            </Field>
            {canManage ? (
              <Button type="submit" size="sm" variant="secondary">
                Save mode
              </Button>
            ) : null}
          </form>
          <p className="mt-2 text-xs text-fg-muted">
            Flag <code className="font-mono">p3.gates</code> must also be enabled
            for the project. New gates are created disabled — enable deliberately
            after previewing.
          </p>
        </PanelBody>
      </Panel>

      <Tabs defaultValue="gates">
        <TabsList>
          <TabsTrigger value="gates">Gates ({gates.length})</TabsTrigger>
          <TabsTrigger value="rubrics">Rubrics ({rubrics.length})</TabsTrigger>
          <TabsTrigger value="bindings">Bindings ({bindings.length})</TabsTrigger>
          <TabsTrigger value="approvals">
            Approvals ({pending.length})
          </TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
        </TabsList>

        <TabsContent value="gates" className="mt-4 space-y-4">
          {canManage ? (
            <Panel>
              <PanelHeader>
                <span className="text-sm font-medium">Create gate</span>
              </PanelHeader>
              <PanelBody>
                <form action={actionCreateGate} className="grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="projectId" value={project.value.id} />
                  <input type="hidden" name="projectKey" value={projectKey} />
                  <Field label="Name">
                    <Input name="name" required placeholder="Complexity required" />
                  </Field>
                  <Field label="Evaluator">
                    <select
                      name="evaluator"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue="field_rule"
                    >
                      <option value="field_rule">field_rule</option>
                      <option value="human_approval">human_approval</option>
                      <option value="budget">budget</option>
                      <option value="loop_budget">loop_budget</option>
                      <option value="agentic">agentic</option>
                      <option value="visual_confirmation">
                        visual_confirmation
                      </option>
                    </select>
                  </Field>
                  <Field label="Rubric (agentic)">
                    <select
                      name="rubricId"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue={rubrics[0]?.id ?? ''}
                    >
                      <option value="">—</option>
                      {rubrics.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} v{r.version}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Remediation binding (agentic Block)">
                    <select
                      name="remediationBindingId"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue=""
                    >
                      <option value="">None</option>
                      {bindings.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Warning code (agentic)">
                    <Input name="warningCode" placeholder="spec.not_testable" />
                  </Field>
                  {!acEnabled ? (
                    <p className="sm:col-span-2 text-xs text-fg-muted">
                      Acceptance-criteria field conditions are hidden — enable
                      the optional concept in Settings to use them.
                    </p>
                  ) : null}
                  <Field label="Trigger">
                    <select
                      name="triggerKind"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue="on_transition"
                    >
                      <option value="on_transition">on_transition</option>
                      <option value="on_run_finished">on_run_finished</option>
                      <option value="on_label_added">on_label_added</option>
                    </select>
                  </Field>
                  <Field label="From stage (optional)">
                    <select
                      name="fromStageId"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue=""
                    >
                      <option value="">Any</option>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="To stage (transition)">
                    <select
                      name="toStageId"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue={stages[0]?.id}
                    >
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Loop scope">
                    <select
                      name="loopScope"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue="item"
                    >
                      <option value="item">item</option>
                      <option value="stage">stage</option>
                      <option value="stage_pair">stage_pair</option>
                    </select>
                  </Field>
                  <Field label="Warn at (loop_budget)">
                    <Input name="warnAt" type="number" defaultValue={2} />
                  </Field>
                  <Field label="Escalate at">
                    <Input name="escalateAt" type="number" defaultValue={3} />
                  </Field>
                  <Field label="Block at (optional)">
                    <Input name="blockAt" type="number" placeholder="omit = never" />
                  </Field>
                  <Field label="Loop from stage (pair)">
                    <select
                      name="loopFromStageId"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue=""
                    >
                      <option value="">—</option>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Loop to stage (pair/stage)">
                    <select
                      name="loopToStageId"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue=""
                    >
                      <option value="">—</option>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Label key (on_label_added)">
                    <Input name="labelKey" placeholder="risk:high" />
                  </Field>
                  <Field label="On failure">
                    <select
                      name="onFailure"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue="block"
                    >
                      <option value="block">block</option>
                      <option value="warn">warn</option>
                    </select>
                  </Field>
                  <Field label="Field (field_rule)">
                    <select
                      name="field"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue="ticket.complexity"
                    >
                      <option value="ticket.complexity">ticket.complexity</option>
                      <option value="spec.exists">spec.exists</option>
                      {acEnabled ? (
                        <option value="spec.acceptance_criteria.count">
                          spec.acceptance_criteria.count
                        </option>
                      ) : null}
                      <option value="warnings.open.count">warnings.open.count</option>
                    </select>
                  </Field>
                  <Field label="Operator">
                    <select
                      name="op"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue="exists"
                    >
                      <option value="exists">exists</option>
                      <option value="missing">missing</option>
                      <option value="eq">eq</option>
                      <option value="has_label">has_label</option>
                      <option value="lacks_label">lacks_label</option>
                      <option value="count_gte">count_gte</option>
                    </select>
                  </Field>
                  <Field label="Value / label">
                    <Input name="value" placeholder="medium / risk:high / 1" />
                  </Field>
                  <Field label="Message">
                    <Input name="message" placeholder="Why this gate stops work" />
                  </Field>
                  <Field label="Warning code">
                    <Input name="code" placeholder="spec.thin" />
                  </Field>
                  <Field label="Approval instructions">
                    <Textarea name="instructions" rows={2} />
                  </Field>
                  <Field label="Approver roles (comma-separated)">
                    <Input
                      name="approverRoles"
                      defaultValue="owner,maintainer"
                      placeholder="owner,maintainer"
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm text-fg">
                    <input type="checkbox" name="allowSelfApproval" />
                    Allow self-approval
                  </label>
                  <label className="flex items-center gap-2 text-sm text-fg">
                    <input type="checkbox" name="enabled" />
                    Enable immediately
                  </label>
                  <div className="sm:col-span-2">
                    <Button type="submit">Create gate (disabled by default unless checked)</Button>
                  </div>
                </form>
              </PanelBody>
            </Panel>
          ) : null}

          {gates.length === 0 ? (
            <EmptyState
              title="No gates yet"
              description="Create a field rule or human approval gate. Gates are disabled until you enable them after previewing their effect on current items."
            />
          ) : (
            gates.map((g) => {
              const trigger = g.trigger as {
                kind: string;
                toStageId?: string;
                labelKey?: string;
              };
              const requireAst =
                g.evaluator === 'field_rule'
                  ? (g.config as { require?: unknown }).require
                  : null;
              const described =
                requireAst && typeof requireAst === 'object'
                      ? describeCondition(requireAst as ConditionAst)
                  : null;
              const preview = previews[g.id] ?? [];
              const counts = {
                pass: preview.filter((p) => p.outcome === 'pass').length,
                warn: preview.filter((p) => p.outcome === 'warn').length,
                block: preview.filter((p) => p.outcome === 'block').length,
              };
              return (
                <Panel key={g.id}>
                  <PanelHeader className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-fg">{g.name}</span>
                    <Badge tone={g.enabled ? 'success' : 'neutral'}>
                      {g.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                    <Badge tone="neutral">{g.evaluator}</Badge>
                    <Badge tone={g.onFailure === 'warn' ? 'warning' : 'danger'}>
                      on_failure:{g.onFailure}
                    </Badge>
                    <span className="font-mono text-[10px] text-fg-muted">
                      v{g.version}
                    </span>
                  </PanelHeader>
                  <PanelBody className="space-y-2">
                    <p className="text-xs text-fg-muted">
                      Trigger: {trigger.kind}
                      {trigger.toStageId
                        ? ` → ${stageById.get(trigger.toStageId)?.name ?? trigger.toStageId}`
                        : ''}
                      {trigger.labelKey ? ` · ${trigger.labelKey}` : ''}
                    </p>
                    {described ? (
                      <p className="text-sm text-fg">
                        Requires: <em>{described}</em>
                      </p>
                    ) : null}
                    {g.enabled && preview.length > 0 ? (
                      <p className="text-xs text-fg-muted">
                        Preview on {preview.length} items: {counts.pass} pass ·{' '}
                        {counts.warn} warn · {counts.block} block
                      </p>
                    ) : null}
                    {canManage ? (
                      <div className="flex gap-2">
                        <form action={actionEnableGate}>
                          <input type="hidden" name="gateId" value={g.id} />
                          <input type="hidden" name="projectKey" value={projectKey} />
                          <input
                            type="hidden"
                            name="enabled"
                            value={g.enabled ? 'off' : 'on'}
                          />
                          <Button type="submit" size="sm" variant="secondary">
                            {g.enabled ? 'Disable' : 'Enable'}
                          </Button>
                        </form>
                        <form action={actionArchiveGate}>
                          <input type="hidden" name="gateId" value={g.id} />
                          <input type="hidden" name="projectKey" value={projectKey} />
                          <Button type="submit" size="sm" variant="ghost">
                            Archive
                          </Button>
                        </form>
                      </div>
                    ) : null}
                  </PanelBody>
                </Panel>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="rubrics" className="mt-4 space-y-4">
          {canManage ? (
            <Panel>
              <PanelHeader>
                <span className="text-sm font-medium">Create rubric</span>
              </PanelHeader>
              <PanelBody>
                <form action={actionCreateRubric} className="grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="projectId" value={project.value.id} />
                  <input type="hidden" name="projectKey" value={projectKey} />
                  <Field label="Seeded template">
                    <select
                      name="template"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue={SEEDED_RUBRIC_TEMPLATES[0]?.name}
                    >
                      {SEEDED_RUBRIC_TEMPLATES.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Uncertainty policy">
                    <select
                      name="uncertaintyPolicy"
                      className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
                      defaultValue="warn"
                    >
                      <option value="warn">warn (default)</option>
                      <option value="pass">pass</option>
                      <option value="block">block</option>
                    </select>
                  </Field>
                  <Field label="Name override">
                    <Input name="name" placeholder="Leave blank to use template name" />
                  </Field>
                  <Field label="Model">
                    <Input name="model" defaultValue="gpt-4o-mini" />
                  </Field>
                  <Button type="submit" className="w-fit">
                    Create from template
                  </Button>
                </form>
              </PanelBody>
            </Panel>
          ) : null}

          {rubrics.length === 0 ? (
            <EmptyState
              title="No rubrics"
              description="Create a seeded rubric above, then wire it into an agentic gate."
            />
          ) : (
            rubrics.map((r) => (
              <Panel key={r.id}>
                <PanelHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{r.name}</span>
                    <Badge tone={r.enabled ? 'active' : 'neutral'}>
                      v{r.version} · {r.enabled ? 'enabled' : 'draft'}
                    </Badge>
                  </div>
                </PanelHeader>
                <PanelBody className="space-y-2 text-sm">
                  <p className="text-fg-muted">
                    {describeRubric({
                      name: r.name,
                      version: r.version,
                      question: r.question,
                      criteriaCount: Array.isArray(r.criteria)
                        ? r.criteria.length
                        : 0,
                      uncertaintyPolicy: r.uncertaintyPolicy,
                      enabled: r.enabled,
                    })}
                  </p>
                  <p>
                    <span className="text-fg-subtle">Question: </span>
                    {r.question}
                  </p>
                  <ul className="list-inside list-disc text-fg-muted">
                    {(r.criteria as Array<{ key: string; weight: string; statement: string }>).map(
                      (c) => (
                        <li key={c.key}>
                          [{c.weight}] {c.key}: {c.statement}
                        </li>
                      ),
                    )}
                  </ul>
                  {canManage ? (
                    <div className="flex flex-wrap gap-2 pt-2">
                      <form action={actionRunGoldenSet}>
                        <input type="hidden" name="rubricId" value={r.id} />
                        <input type="hidden" name="projectKey" value={projectKey} />
                        <Button type="submit" size="sm" variant="secondary">
                          Run golden set
                        </Button>
                      </form>
                      <form action={actionEnableRubric} className="flex items-center gap-2">
                        <input type="hidden" name="rubricId" value={r.id} />
                        <input type="hidden" name="projectKey" value={projectKey} />
                        <label className="flex items-center gap-1 text-xs text-fg-muted">
                          <input type="checkbox" name="acknowledgeSkippedRegression" />
                          Skip regression ack
                        </label>
                        <Button type="submit" size="sm">
                          Enable version
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </PanelBody>
              </Panel>
            ))
          )}
        </TabsContent>

        <TabsContent value="bindings" className="mt-4">
          <Panel>
            <PanelBody className="space-y-2">
              <p className="text-sm text-fg-muted">
                Bindings are still edited under Settings for launch config; listed
                here so policy authors see stage automations alongside gates.
              </p>
              {bindings.length === 0 ? (
                <EmptyState
                  title="No bindings"
                  description="Add automation bindings in project Settings."
                />
              ) : (
                bindings.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between border-b border-border py-2 text-sm"
                  >
                    <span className="text-fg">{b.name}</span>
                    <span className="text-fg-muted">
                      {stageById.get(b.stageId)?.name ?? b.stageId} · {b.adapter}
                      {b.enabled ? '' : ' · disabled'}
                    </span>
                  </div>
                ))
              )}
            </PanelBody>
          </Panel>
        </TabsContent>

        <TabsContent value="approvals" className="mt-4">
          <Panel>
            <PanelBody className="space-y-2">
              {pending.length === 0 ? (
                <EmptyState
                  title="No pending approvals"
                  description="Human approval gates create requests here when a transition waits for a person."
                />
              ) : (
                pending.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between border-b border-border py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-fg-muted">{a.id.slice(0, 8)}</span>
                      {a.stale ? (
                        <Badge tone="warning" title="Pending longer than 48 hours">
                          stale
                        </Badge>
                      ) : null}
                    </div>
                    <a
                      className="text-link"
                      href={`/projects/${projectKey}/items/${items.find((i) => i.id === a.workItemId)?.key ?? ''}`}
                    >
                      Open ticket
                    </a>
                  </div>
                ))
              )}
            </PanelBody>
          </Panel>
        </TabsContent>

        <TabsContent value="budgets" className="mt-4">
          <EmptyState
            title="Budgets land in Phase 4"
            description="This tab is a placeholder so Policy Studio already has a home for soft/hard thresholds without redesigning the surface."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

