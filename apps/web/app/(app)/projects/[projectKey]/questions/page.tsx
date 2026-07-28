import Link from 'next/link';
import {
  getProjectByKey,
  listOpenQuestionsForProject,
  listWorkItems,
} from '@nexus/core';
import {
  Badge,
  Button,
  Field,
  Panel,
  PanelBody,
  Textarea,
} from '@nexus/ui';
import { notFound } from 'next/navigation';
import { actionAnswerQuestion } from '../../../../../src/server/actions';
import { requireSession } from '../../../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function QuestionsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const [qsR, itemsR] = await Promise.all([
    listOpenQuestionsForProject(ctx, project.value.id),
    listWorkItems(ctx, project.value.id),
  ]);
  const questions = qsR.ok ? qsR.value : [];
  const items = itemsR.ok ? itemsR.value : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">Open questions</h2>
        <p className="text-sm text-fg-muted">
        Use the ranked inbox for blocking questions across projects. This list is a project-scoped view; answers also appear on the ticket.
      </p>
      {questions.length === 0 ? (
        <p className="text-sm text-fg-subtle">No open questions.</p>
      ) : (
        <ul className="space-y-3">
          {questions.map((q) => {
            const item = itemById.get(q.workItemId);
            return (
              <Panel key={q.id}>
                <PanelBody className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    {item ? (
                      <Link
                        href={`/projects/${projectKey}/items/${item.key}`}
                        className="font-mono text-link hover:underline"
                      >
                        {item.key}
                      </Link>
                    ) : (
                      <span className="font-mono">{q.workItemId}</span>
                    )}
                    {q.blocking ? <Badge tone="warning">blocking</Badge> : <Badge tone="neutral">optional</Badge>}
                  </div>
                  <p className="text-sm text-fg">{q.text}</p>
                  <form action={actionAnswerQuestion} className="grid gap-2">
                    <input type="hidden" name="questionId" value={q.id} />
                    <input type="hidden" name="projectKey" value={projectKey} />
                    <input type="hidden" name="itemKey" value={item?.key ?? ''} />
                    <Field label="Answer">
                      <Textarea name="answer" required rows={2} placeholder="Your answer" />
                    </Field>
                    <Button type="submit" size="sm" className="w-fit">
                      Answer{q.blocking ? ' & resume' : ''}
                    </Button>
                  </form>
                </PanelBody>
              </Panel>
            );
          })}
        </ul>
      )}
    </div>
  );
}
