import { getProjectByKey, listProjectEvents } from '@nexus/core';
import {
  Badge,
  Button,
  DataList,
  DataListItem,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelBody,
  Toolbar,
} from '@nexus/ui';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<{ type?: string; subject?: string }>;
}) {
  const { projectKey } = await params;
  const filters = await searchParams;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const eventsR = await listProjectEvents(ctx, project.value.id, {
    subjectId: filters.subject,
    limit: 200,
  });
  let events = eventsR.ok ? eventsR.value : [];
  if (filters.type) {
    events = events.filter((e) => e.type === filters.type);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-fg">Audit</h2>
        <p className="text-xs text-fg-muted">
          Reconstructed from the event outbox — no separate audit log.
        </p>
      </div>
      <Panel>
        <Toolbar>
          <form className="flex flex-wrap items-end gap-2 flex-1">
            <Field label="Type" className="min-w-[16rem] flex-1">
              <Input
                name="type"
                defaultValue={filters.type ?? ''}
                placeholder="work_item.stage_changed"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Subject" className="min-w-[16rem] flex-1">
              <Input
                name="subject"
                defaultValue={filters.subject ?? ''}
                placeholder="subject uuid"
                className="font-mono text-xs"
              />
            </Field>
            <Button type="submit" variant="secondary" size="sm">
              Filter
            </Button>
          </form>
        </Toolbar>
        <PanelBody className="p-0">
          {events.length === 0 ? (
            <EmptyState title="No events match" />
          ) : (
            <DataList>
              {events.map((e) => (
                <DataListItem key={e.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Badge tone="info" className="font-mono normal-case">
                      {e.type}
                    </Badge>
                    <span className="text-xs text-fg-subtle">
                      {e.occurredAt.toISOString()}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-fg-muted">
                    {e.subjectType}:{e.subjectId} · actor{' '}
                    {JSON.stringify(e.actor)}
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-fg-subtle">
                      Payload
                    </summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-fg-muted">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                  </details>
                </DataListItem>
              ))}
            </DataList>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
