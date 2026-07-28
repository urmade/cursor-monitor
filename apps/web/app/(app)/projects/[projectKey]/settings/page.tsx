import {
  can,
  getProjectByKey,
  getProjectRole,
  isAcceptanceCriteriaEnabled,
  isVisualConfirmationEnabled,
  listBindings,
  listLabels,
  listPromptTemplates,
  listReasonCodes,
  listStages,
  listWorkItems,
  listWebhookEndpoints,
  listWebhookDeliveries,
  parseProjectBudgetSettings,
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
  actionArchiveBinding,
  actionArchiveReasonCode,
  actionCreateDefaultPrompt,
  actionRenameStage,
  actionTestResolveBinding,
  actionUpdateBudgetSettings,
  actionUpdateProject,
  actionUpsertBinding,
  actionUpsertLabel,
  actionUpsertReasonCode,
  actionReplayWebhookDelivery,
  actionReEnableWebhookEndpoint,
} from '../../../../../src/server/actions';
import { WebhookEndpointRegisterForm } from './webhook-endpoint-form';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<{ resolve?: string }>;
}) {
  const { projectKey } = await params;
  const sp = await searchParams;
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
  const canBindings = can(ctx.actor, 'project.manage_bindings', {
    type: 'project',
    projectId: project.value.id,
    role,
  });

  const [stagesR, labelsR, bindingsR, templatesR, itemsR, reasonsR] =
    await Promise.all([
      listStages(ctx, project.value.id),
      listLabels(ctx, project.value.id),
      listBindings(ctx, project.value.id),
      listPromptTemplates(ctx, project.value.id),
      listWorkItems(ctx, project.value.id),
      listReasonCodes(ctx, project.value.id),
    ]);
  const stages = stagesR.ok ? stagesR.value : [];
  const labels = labelsR.ok ? labelsR.value : [];
  const bindings = bindingsR.ok ? bindingsR.value : [];
  const templates = templatesR.ok ? templatesR.value : [];
  const items = itemsR.ok ? itemsR.value : [];
  const reasons = reasonsR.ok ? reasonsR.value : [];
  const acOn = isAcceptanceCriteriaEnabled(project.value.optionalConcepts);
  const vcOn = isVisualConfirmationEnabled(project.value.optionalConcepts);
  const budgetSettings = parseProjectBudgetSettings(
    project.value.settings as Record<string, unknown>,
  );
  const capUsd =
    budgetSettings.burnCapMicroUsd != null
      ? Number(budgetSettings.burnCapMicroUsd) / 1_000_000
      : 100;

  const endpointsR = canUpdate
    ? await listWebhookEndpoints(ctx, project.value.id)
    : null;
  const endpoints = endpointsR?.ok ? endpointsR.value : [];
  const deliveriesByEndpoint = await Promise.all(
    endpoints.map(async (ep) => {
      const d = await listWebhookDeliveries(ctx, ep.id, { limit: 20 });
      return { ep, deliveries: d.ok ? d.value : [] };
    }),
  );

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
              <fieldset className="space-y-2 rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-fg-muted">
                  Optional concepts
                </legend>
                <input type="hidden" name="optionalConceptsPresent" value="1" />
                <p className="text-xs text-fg-subtle">
                  When off, the concept does not exist — no UI section, no MCP
                  nagging, no completeness gap.
                </p>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="acceptanceCriteria"
                    defaultChecked={acOn}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Acceptance criteria</span>
                    <span className="block text-xs text-fg-muted">
                      Adds a spec section and allows gates/rubrics to reference
                      them.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="visualConfirmation"
                    defaultChecked={vcOn}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Visual confirmation</span>
                    <span className="block text-xs text-fg-muted">
                      Enables the visual_confirmation gate type (preview/artifact
                      refs, optional approval).
                    </span>
                  </span>
                </label>
              </fieldset>
              <Button type="submit" className="w-fit">Save</Button>
            </form>
          ) : (
            <p className="text-sm text-fg-muted">{project.value.description}</p>
          )}
          <p className="mt-4 text-xs text-fg-subtle">Your role: {role ?? 'none'}</p>
        </PanelBody>
      </Panel>

      {canUpdate ? (
        <Panel>
          <PanelHeader>
            <span className="text-sm font-medium">Budget defaults</span>
          </PanelHeader>
          <PanelBody>
            <form action={actionUpdateBudgetSettings} className="grid gap-3">
              <input type="hidden" name="projectId" value={project.value.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <Field label="Project burn cap (USD)">
                <Input
                  name="burnCapUsd"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  defaultValue={capUsd}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Low soft (USD)">
                  <Input
                    name="lowSoftUsd"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={
                      Number(budgetSettings.complexityDefaults.low.softMicroUsd) /
                      1_000_000
                    }
                  />
                </Field>
                <Field label="Low hard (USD)">
                  <Input
                    name="lowHardUsd"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={
                      Number(budgetSettings.complexityDefaults.low.hardMicroUsd) /
                      1_000_000
                    }
                  />
                </Field>
                <Field label="Medium soft (USD)">
                  <Input
                    name="mediumSoftUsd"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={
                      Number(budgetSettings.complexityDefaults.medium.softMicroUsd) /
                      1_000_000
                    }
                  />
                </Field>
                <Field label="Medium hard (USD)">
                  <Input
                    name="mediumHardUsd"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={
                      Number(budgetSettings.complexityDefaults.medium.hardMicroUsd) /
                      1_000_000
                    }
                  />
                </Field>
                <Field label="High soft (USD)">
                  <Input
                    name="highSoftUsd"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={
                      Number(budgetSettings.complexityDefaults.high.softMicroUsd) /
                      1_000_000
                    }
                  />
                </Field>
                <Field label="High hard (USD)">
                  <Input
                    name="highHardUsd"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={
                      Number(budgetSettings.complexityDefaults.high.hardMicroUsd) /
                      1_000_000
                    }
                  />
                </Field>
              </div>
              <Button type="submit" className="w-fit">
                Save budget settings
              </Button>
            </form>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader>
          <span className="text-sm font-medium">Loop reason codes</span>
        </PanelHeader>
        <PanelBody className="space-y-3">
          <ul className="space-y-2 text-sm">
            {reasons.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2"
              >
                <div>
                  <div className="font-medium">{r.label}</div>
                  <div className="font-mono text-[11px] text-fg-subtle">
                    {r.code}
                    {r.requiresNote ? ' · note required' : ''}
                  </div>
                </div>
                {canUpdate ? (
                  <form action={actionArchiveReasonCode}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="projectKey" value={projectKey} />
                    <Button type="submit" variant="ghost" size="sm">
                      Archive
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
            {reasons.length === 0 ? (
              <li className="text-sm text-fg-muted">No reason codes seeded yet.</li>
            ) : null}
          </ul>
          {canUpdate ? (
            <form
              action={actionUpsertReasonCode}
              className="grid gap-2 border-t border-border pt-3"
            >
              <input type="hidden" name="projectId" value={project.value.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <Field label="Code">
                <Input name="code" required placeholder="custom_reason" className="font-mono text-xs" />
              </Field>
              <Field label="Label">
                <Input name="label" required placeholder="Custom reason" />
              </Field>
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <input type="checkbox" name="requiresNote" /> Requires note
              </label>
              <Button type="submit" className="w-fit" size="sm">
                Add / update reason
              </Button>
            </form>
          ) : null}
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

      <Panel className="lg:col-span-2">
        <PanelHeader>
          <span className="text-sm font-medium">Automation bindings</span>
        </PanelHeader>
        <PanelBody className="space-y-4">
          {sp.resolve ? (
            <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs text-fg-muted">
              Resolve: {sp.resolve}
            </p>
          ) : null}
          <ul className="space-y-2 text-sm">
            {bindings.map((b) => {
              const stage = stages.find((s) => s.id === b.stageId);
              return (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2"
                >
                  <div>
                    <div className="font-medium">{b.name}</div>
                    <div className="text-[11px] text-fg-subtle">
                      {stage?.name ?? b.stageId} · {b.adapter} · priority {b.priority}
                      {b.enabled ? '' : ' · disabled'}
                    </div>
                  </div>
                  {canBindings ? (
                    <form action={actionArchiveBinding}>
                      <input type="hidden" name="bindingId" value={b.id} />
                      <input type="hidden" name="projectKey" value={projectKey} />
                      <Button type="submit" variant="ghost" size="sm">
                        Archive
                      </Button>
                    </form>
                  ) : null}
                </li>
              );
            })}
            {bindings.length === 0 ? (
              <li className="text-sm text-fg-muted">No bindings yet.</li>
            ) : null}
          </ul>

          {canBindings ? (
            <>
              <form
                action={actionCreateDefaultPrompt}
                className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
              >
                <input type="hidden" name="projectId" value={project.value.id} />
                <input type="hidden" name="projectKey" value={projectKey} />
                <Field label="Prompt template name">
                  <Input name="name" defaultValue="default" />
                </Field>
                <Button type="submit" variant="secondary" size="sm">
                  Create prompt template
                </Button>
              </form>
              <p className="text-xs text-fg-subtle">
                Templates: {templates.map((t) => `${t.name}@v${t.version}`).join(', ') || 'none'}
              </p>

              <form
                action={actionUpsertBinding}
                className="grid max-w-xl gap-2 border-t border-border pt-4"
              >
                <input type="hidden" name="projectId" value={project.value.id} />
                <input type="hidden" name="projectKey" value={projectKey} />
                <div className="text-xs text-fg-subtle">Add cloud_agent binding</div>
                <Field label="Name">
                  <Input name="name" required defaultValue="Scoping" />
                </Field>
                <Field label="Stage">
                  <select
                    name="stageId"
                    required
                    className={inputClass}
                    defaultValue={stages[0]?.id}
                  >
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <input type="hidden" name="adapter" value="cloud_agent" />
                <Field label="Priority">
                  <Input name="priority" type="number" defaultValue={10} />
                </Field>
                <Field label="Label filter (any of, comma keys)">
                  <Input name="labelKeysAny" placeholder="risk:high" className="font-mono text-xs" />
                </Field>
                <Field label="Prompt template id">
                  <Input
                    name="promptTemplateId"
                    defaultValue={templates[0]?.id ?? ''}
                    className="font-mono text-xs"
                  />
                </Field>
                <label className="flex items-center gap-2 text-xs text-fg-muted">
                  <input type="checkbox" name="noRepo" defaultChecked /> no-repo agent (demo)
                </label>
                <Field label="Repo URL (optional)">
                  <Input name="repoUrl" placeholder="https://github.com/org/repo" />
                </Field>
                <Field label="Starting ref">
                  <Input name="startingRef" defaultValue="main" />
                </Field>
                <Field label="Max duration (minutes)">
                  <Input name="maxDurationMinutes" type="number" defaultValue={60} />
                </Field>
                <Button type="submit" className="w-fit">Save binding</Button>
              </form>

              <form
                action={actionTestResolveBinding}
                className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
              >
                <input type="hidden" name="projectKey" value={projectKey} />
                <Field label="Test resolve for work item">
                  <select name="workItemId" className={inputClass} required defaultValue="">
                    <option value="" disabled>
                      Select item…
                    </option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.key} — {i.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit" variant="secondary" size="sm">
                  Test resolve
                </Button>
              </form>
            </>
          ) : null}
        </PanelBody>
      </Panel>

      {canUpdate ? (
        <Panel className="lg:col-span-2">
          <PanelHeader>
            <h2 className="text-lg font-semibold">Webhooks &amp; deliveries</h2>
            <p className="text-sm text-fg-muted">
              Outbound events (flag <code className="text-xs">p8.webhooks</code>). Secret shown once on create.
            </p>
          </PanelHeader>
          <PanelBody className="grid gap-6">
            <WebhookEndpointRegisterForm
              projectId={project.value.id}
              projectKey={projectKey}
            />

            {deliveriesByEndpoint.map(({ ep, deliveries }) => (
              <div key={ep.id} className="rounded-md border border-border p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{ep.url}</span>
                  {!ep.enabled ? (
                    <Badge tone="danger">disabled: {ep.disabledReason ?? 'off'}</Badge>
                  ) : (
                    <Badge tone="neutral">enabled</Badge>
                  )}
                </div>
                {!ep.enabled && ep.disabledAt ? (
                  <form action={actionReEnableWebhookEndpoint} className="mb-3">
                    <input type="hidden" name="endpointId" value={ep.id} />
                    <input type="hidden" name="projectKey" value={projectKey} />
                    <Button type="submit" size="sm" variant="secondary">
                      Re-enable (sends test event first)
                    </Button>
                  </form>
                ) : null}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="py-1 pr-2">Status</th>
                        <th className="py-1 pr-2">Event</th>
                        <th className="py-1 pr-2">Attempts</th>
                        <th className="py-1 pr-2">Error</th>
                        <th className="py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.map((d) => (
                        <tr key={d.id} className="border-b border-border/60">
                          <td className="py-1 pr-2">{d.status}</td>
                          <td className="py-1 pr-2 font-mono text-xs">{d.eventType}</td>
                          <td className="py-1 pr-2">{d.attempts}</td>
                          <td className="py-1 pr-2 text-xs text-fg-muted">
                            {d.error ?? d.responseStatus ?? '—'}
                          </td>
                          <td className="py-1">
                            {d.status === 'failed' || d.status === 'dead' ? (
                              <form action={actionReplayWebhookDelivery}>
                                <input type="hidden" name="deliveryId" value={d.id} />
                                <input type="hidden" name="projectKey" value={projectKey} />
                                <Button type="submit" size="sm" variant="ghost">
                                  Replay
                                </Button>
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </PanelBody>
        </Panel>
      ) : null}

    </div>
  );
}
