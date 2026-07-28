import {
  can,
  getProjectByKey,
  getProjectRole,
  listBudgetEvents,
  parseProjectBudgetSettings,
  aggregateSpendSource,
  listWorkItems,
} from '@nexus/core';
import {
  Button,
  CostSourceBadge,
  Field,
  formatMicroUsdDisplay,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  Textarea,
} from '@nexus/ui';
import { notFound } from 'next/navigation';
import {
  actionRaiseProjectCap,
} from '../../../../../src/server/actions';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function SpendPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const role = await getProjectRole(ctx, project.value.id);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId: project.value.id,
      role,
    })
  ) {
    notFound();
  }

  const canUpdate = can(ctx.actor, 'project.update', {
    type: 'project',
    projectId: project.value.id,
    role,
  });

  const budget = parseProjectBudgetSettings(
    project.value.settings as Record<string, unknown>,
  );
  const spent = project.value.spendMicroUsd ?? BigInt(0);
  const cap = budget.burnCapMicroUsd;

  const eventsR = await listBudgetEvents(ctx, project.value.id, 200);
  const events = eventsR.ok ? eventsR.value : [];
  const itemsR = await listWorkItems(ctx, project.value.id);
  const itemSources =
    itemsR.ok && spent > BigInt(0)
      ? itemsR.value.map((i) => i.spendSource)
      : [];
  const projectSpendSource = aggregateSpendSource(itemSources);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Spend &amp; budget audit</h2>
        <p className="text-sm text-fg-muted">
          Project burn: {formatMicroUsdDisplay(spent)}
          {cap != null ? ` of ${formatMicroUsdDisplay(cap)} cap` : ''}{' '}
          {projectSpendSource ? (
            <CostSourceBadge source={projectSpendSource} className="inline-flex" />
          ) : null}
        </p>
      </div>

      {canUpdate ? (
        <Panel>
          <PanelHeader>
            <span className="text-sm font-medium">Raise project burn cap</span>
          </PanelHeader>
          <PanelBody>
            <form action={actionRaiseProjectCap} className="grid max-w-md gap-3">
              <input type="hidden" name="projectId" value={project.value.id} />
              <input type="hidden" name="projectKey" value={projectKey} />
              <Field label="New cap (USD)">
                <Input name="capUsd" type="number" step="0.01" min="0" required />
              </Field>
              <Field label="Reason (required)">
                <Textarea name="reason" required rows={2} />
              </Field>
              <Button type="submit" className="w-fit">
                Raise cap
              </Button>
            </form>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader>
          <span className="text-sm font-medium">Budget events</span>
        </PanelHeader>
        <PanelBody>
          <ul className="space-y-3 text-sm">
            {events.length === 0 ? (
              <li className="text-fg-muted">No budget events yet.</li>
            ) : (
              events.map((ev) => (
                <li key={ev.id} className="border-b border-border pb-2">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-mono text-xs text-fg-subtle">
                      {ev.kind} · {ev.scope}
                    </span>
                    <time className="text-xs text-fg-muted">
                      {ev.createdAt.toISOString()}
                    </time>
                  </div>
                  {ev.reason ? (
                    <p className="mt-1 text-fg">{ev.reason}</p>
                  ) : null}
                  <pre className="mt-1 max-h-24 overflow-auto rounded bg-surface-muted p-2 text-[10px] text-fg-muted">
                    {JSON.stringify({ before: ev.before, after: ev.after }, null, 2)}
                  </pre>
                </li>
              ))
            )}
          </ul>
        </PanelBody>
      </Panel>
    </div>
  );
}
