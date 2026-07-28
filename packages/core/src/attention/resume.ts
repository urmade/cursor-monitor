import { eq } from 'drizzle-orm';
import { jobs, newId, questions, runs } from '@nexus/db';
import type { ServiceContext } from '../context';
import { launchRun } from '../runs/lifecycle';

export type ResumeOutcome =
  | { status: 'resumed'; runId: string; branch: 'follow_up' | 'fresh_launch' }
  | { status: 'retrying'; runId: string | null; branch: 'agent_busy' }
  | { status: 'failed'; branch: 'no_binding' | 'provider_error'; message: string };

async function enqueueResumeAfterQuestion(
  ctx: ServiceContext,
  payload: {
    questionId: string;
    answer: string;
    workItemId: string;
    attempt: number;
    forceFreshAgent: boolean;
  },
): Promise<void> {
  const delaySec = Math.min(3600, 15 * 2 ** payload.attempt);
  await ctx.db
    .insert(jobs)
    .values({
      id: newId(),
      kind: 'resume_after_question',
      payload,
      runAfter: new Date(ctx.clock().getTime() + delaySec * 1000),
      dedupeKey: `resume_after_question:${payload.questionId}:${payload.attempt}`,
      priority: 12,
      maxAttempts: 8,
    })
    .onConflictDoNothing();
}

export async function resumeAfterQuestion(
  ctx: ServiceContext,
  input: {
    questionId: string;
    answer: string;
    workItemId: string;
    attempt?: number;
    forceFreshAgent?: boolean;
  },
): Promise<ResumeOutcome> {
  const attempt = input.attempt ?? 0;
  const forceFreshAgent = input.forceFreshAgent ?? false;

  const q = await ctx.db.query.questions.findFirst({
    where: eq(questions.id, input.questionId),
  });
  const originalRun = q?.runId
    ? await ctx.db.query.runs.findFirst({ where: eq(runs.id, q.runId) })
    : null;

  const followUp =
    !forceFreshAgent &&
    Boolean(originalRun?.providerAgentId) &&
    originalRun?.status !== 'abandoned';
  const branch: 'follow_up' | 'fresh_launch' = followUp ? 'follow_up' : 'fresh_launch';

  const launch = await launchRun(ctx, {
    workItemId: input.workItemId,
    bindingId: originalRun?.bindingId ?? undefined,
    resumeAgentId: originalRun?.providerAgentId ?? null,
    forceFreshAgent,
    trigger: {
      kind: 'resume',
      by: {
        questionId: input.questionId,
        answer: input.answer,
        priorRunId: q?.runId,
        priorAgentId: originalRun?.providerAgentId,
        branch,
        attempt,
      },
    },
  });

  if (launch.ok) {
    await ctx.db
      .update(questions)
      .set({ resumeRunId: launch.value.id })
      .where(eq(questions.id, input.questionId));
    return {
      status: 'resumed',
      runId: launch.value.id,
      branch: forceFreshAgent ? 'fresh_launch' : branch,
    };
  }

  if (launch.error.code === 'provider_busy') {
    if (attempt < 6) {
      await enqueueResumeAfterQuestion(ctx, {
        questionId: input.questionId,
        answer: input.answer,
        workItemId: input.workItemId,
        attempt: attempt + 1,
        forceFreshAgent: attempt >= 2 ? true : forceFreshAgent,
      });
    }
    return { status: 'retrying', runId: null, branch: 'agent_busy' };
  }

  if (launch.error.code === 'no_binding') {
    return {
      status: 'failed',
      branch: 'no_binding',
      message: 'Cannot resume automatically — use Run stage on the ticket.',
    };
  }

  return {
    status: 'failed',
    branch: 'provider_error',
    message: launch.error.message,
  };
}
