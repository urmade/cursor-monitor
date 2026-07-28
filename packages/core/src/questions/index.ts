import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  artifactRefs,
  newId,
  questions,
  runs,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { launchRun } from '../runs/lifecycle';

export type Question = typeof questions.$inferSelect;
export type ArtifactRef = typeof artifactRefs.$inferSelect;

export async function askQuestion(
  ctx: ServiceContext,
  input: {
    ticketId: string;
    text: string;
    blocking?: boolean;
    options?: string[];
  },
): Promise<Result<{ question: Question; ticketStatusHint: string }, CoreError>> {
  if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== input.ticketId) {
    return err(coreError('forbidden', 'ticket_id does not match token scope'));
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, input.ticketId), isNull(workItems.archivedAt)),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'work_item.update', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot ask questions'));
  }

  const id = newId();
  const runId = ctx.actor.kind === 'agent' ? ctx.actor.runId : null;
  const [row] = await ctx.db
    .insert(questions)
    .values({
      id,
      workItemId: item.id,
      runId,
      stageInstanceId: item.currentStageInstanceId,
      text: input.text,
      options: input.options ?? [],
      blocking: input.blocking ?? false,
      status: 'open',
    })
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'question.asked',
    subjectType: 'question',
    subjectId: id,
    actor: ctx.actor,
    payload: {
      blocking: input.blocking ?? false,
      text: input.text.slice(0, 200),
    },
  });

  return ok({
    question: row!,
    ticketStatusHint: input.blocking ? 'needs_answer' : 'unchanged',
  });
}

export async function listQuestions(
  ctx: ServiceContext,
  workItemId: string,
  opts?: { limit?: number },
): Promise<Result<{ questions: Question[]; total: number }, CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));
  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'work_item.read', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Work item not found'));
  }

  const all = await ctx.db.query.questions.findMany({
    where: eq(questions.workItemId, workItemId),
    orderBy: [desc(questions.createdAt)],
  });
  const limit = opts?.limit ?? 50;
  return ok({ questions: all.slice(0, limit), total: all.length });
}

export async function listOpenQuestionsForProject(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<Question[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (!can(ctx.actor, 'project.read', { type: 'project', projectId, role })) {
    return err(coreError('not_found', 'Project not found'));
  }
  const items = await ctx.db.query.workItems.findMany({
    where: and(eq(workItems.projectId, projectId), isNull(workItems.archivedAt)),
  });
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return ok([]);

  const rows: Question[] = [];
  for (const id of ids) {
    const qs = await ctx.db.query.questions.findMany({
      where: and(eq(questions.workItemId, id), eq(questions.status, 'open')),
      orderBy: [desc(questions.createdAt)],
    });
    rows.push(...qs);
  }
  return ok(rows);
}

export async function answerQuestion(
  ctx: ServiceContext,
  questionId: string,
  answer: string,
  opts?: { resume?: boolean },
): Promise<Result<{ question: Question; resumeRunId: string | null }, CoreError>> {
  const q = await ctx.db.query.questions.findFirst({
    where: eq(questions.id, questionId),
  });
  if (!q || q.status !== 'open') {
    return err(coreError('not_found', 'Open question not found'));
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, q.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'question.answer', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot answer questions'));
  }

  const [updated] = await ctx.db
    .update(questions)
    .set({
      status: 'answered',
      answer,
      answeredByUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
      answeredAt: new Date(),
    })
    .where(eq(questions.id, questionId))
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'question.answered',
    subjectType: 'question',
    subjectId: questionId,
    actor: ctx.actor,
    payload: { answer: answer.slice(0, 500) },
  });

  let resumeRunId: string | null = null;
  if (opts?.resume !== false && q.blocking) {
    // Resume: prefer follow-up on same agent when available; else fresh launch.
    const originalRun = q.runId
      ? await ctx.db.query.runs.findFirst({ where: eq(runs.id, q.runId) })
      : null;

    const launch = await launchRun(ctx, {
      workItemId: item.id,
      bindingId: originalRun?.bindingId ?? undefined,
      trigger: {
        kind: 'resume',
        by: {
          questionId,
          answer,
          priorRunId: q.runId,
          priorAgentId: originalRun?.providerAgentId,
        },
      },
    });

    if (launch.ok) {
      resumeRunId = launch.value.id;
      await ctx.db
        .update(questions)
        .set({ resumeRunId })
        .where(eq(questions.id, questionId));
    } else {
      ctx.logger.warn(
        { err: launch.error, questionId },
        'resume launch failed after answer',
      );
    }
  }

  const final = await ctx.db.query.questions.findFirst({
    where: eq(questions.id, questionId),
  });
  return ok({ question: final ?? updated!, resumeRunId });
}

export async function withdrawQuestion(
  ctx: ServiceContext,
  questionId: string,
): Promise<Result<Question, CoreError>> {
  const q = await ctx.db.query.questions.findFirst({
    where: eq(questions.id, questionId),
  });
  if (!q || q.status !== 'open') {
    return err(coreError('not_found', 'Open question not found'));
  }
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, q.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));
  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'question.answer', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot withdraw questions'));
  }
  const [updated] = await ctx.db
    .update(questions)
    .set({ status: 'withdrawn' })
    .where(eq(questions.id, questionId))
    .returning();
  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'question.withdrawn',
    subjectType: 'question',
    subjectId: questionId,
    actor: ctx.actor,
    payload: {},
  });
  return ok(updated!);
}

export async function attachArtifactRef(
  ctx: ServiceContext,
  input: {
    ticketId: string;
    kind: string;
    url: string;
    title?: string;
  },
): Promise<Result<ArtifactRef, CoreError>> {
  if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== input.ticketId) {
    return err(coreError('forbidden', 'ticket_id does not match token scope'));
  }
  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, input.ticketId), isNull(workItems.archivedAt)),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const runId = ctx.actor.kind === 'agent' ? ctx.actor.runId : null;
  if (runId) {
    const existing = await ctx.db.query.artifactRefs.findMany({
      where: eq(artifactRefs.runId, runId),
    });
    if (existing.length >= 20) {
      return err(coreError('validation', 'Max 20 artifact refs per run'));
    }
  }

  const [row] = await ctx.db
    .insert(artifactRefs)
    .values({
      id: newId(),
      workItemId: item.id,
      runId,
      kind: input.kind,
      url: input.url,
      title: input.title ?? null,
    })
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'artifact_ref.attached',
    subjectType: 'work_item',
    subjectId: item.id,
    actor: ctx.actor,
    payload: { kind: input.kind, url: input.url },
  });

  return ok(row!);
}

export async function listArtifactRefs(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Result<ArtifactRef[], CoreError>> {
  const rows = await ctx.db.query.artifactRefs.findMany({
    where: eq(artifactRefs.workItemId, workItemId),
    orderBy: [desc(artifactRefs.createdAt)],
  });
  return ok(rows);
}
