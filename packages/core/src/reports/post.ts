import { and, desc, eq, isNull } from 'drizzle-orm';
import { StageReportSchema } from '@nexus/contracts';
import {
  artifactRefs,
  labels,
  newId,
  questions,
  runs,
  stageInstances,
  stageReports,
  stages,
  workItemLabels,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { createSpecVersion } from '../specs/create';

export type StageReport = typeof stageReports.$inferSelect;

export type PostStageReportResult = {
  report: StageReport;
  alreadyPosted: boolean;
  applied: {
    labelsAdded: string[];
    questionsCreated: number;
    artifacts: number;
  };
};

export async function postStageReport(
  ctx: ServiceContext,
  raw: unknown,
): Promise<Result<PostStageReportResult, CoreError>> {
  const parsed = StageReportSchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      coreError('validation', 'Invalid stage report', {
        issues: parsed.error.flatten(),
      }),
    );
  }
  const report = parsed.data;

  if (ctx.actor.kind !== 'agent') {
    return err(coreError('forbidden', 'Only agents can post stage reports'));
  }
  if (ctx.actor.workItemId !== report.ticket_id) {
    return err(coreError('forbidden', 'ticket_id does not match token scope'));
  }

  const runId = ctx.actor.runId;
  const existing = await ctx.db.query.stageReports.findFirst({
    where: eq(stageReports.runId, runId),
  });
  if (existing) {
    return ok({
      report: existing,
      alreadyPosted: true,
      applied: { labelsAdded: [], questionsCreated: 0, artifacts: 0 },
    });
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, report.ticket_id), isNull(workItems.archivedAt)),
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
    return err(coreError('forbidden', 'Cannot post report'));
  }

  const run = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run || run.workItemId !== item.id) {
    return err(coreError('forbidden', 'Run does not belong to this ticket'));
  }

  const stage = await ctx.db.query.stages.findFirst({
    where: eq(stages.id, item.currentStageId),
  });
  if (stage && report.stage !== stage.key && report.stage !== stage.name) {
    // Soft warning — still accept; agents may echo either.
    ctx.logger.warn(
      { expected: stage.key, got: report.stage },
      'stage echo mismatch on report',
    );
  }

  // Validate labels wholly before applying.
  const projectLabels = await ctx.db.query.labels.findMany({
    where: and(eq(labels.projectId, item.projectId), isNull(labels.archivedAt)),
  });
  const byKey = new Map(projectLabels.map((l) => [l.key, l]));
  const unknown: string[] = [];
  const notSettable: string[] = [];
  for (const key of report.labels_to_set) {
    const label = byKey.get(key);
    if (!label) unknown.push(key);
    else if (!label.agentSettable) notSettable.push(key);
  }
  if (unknown.length) {
    return err(
      coreError('validation', `Unknown label(s): ${unknown.join(', ')}`, {
        labels_unknown: unknown,
      }),
    );
  }
  if (notSettable.length) {
    return err(
      coreError(
        'validation',
        `Label(s) not agent-settable: ${notSettable.join(', ')}`,
        { labels_not_agent_settable: notSettable },
      ),
    );
  }

  const artifactCountOnRun = await ctx.db.query.artifactRefs.findMany({
    where: eq(artifactRefs.runId, runId),
  });
  if (artifactCountOnRun.length + report.artifact_refs.length > 20) {
    return err(coreError('validation', 'Too many artifact refs for this run (max 20)'));
  }

  const result = await ctx.db.transaction(async (tx) => {
    const reportId = newId();
    const [row] = await tx
      .insert(stageReports)
      .values({
        id: reportId,
        workItemId: item.id,
        stageInstanceId: run.stageInstanceId,
        runId,
        outcome: report.outcome,
        confidence:
          report.confidence !== undefined ? String(report.confidence) : null,
        headline: report.headline,
        summary: report.summary,
        assumptions: report.assumptions,
        notVerified: report.not_verified,
        raw: report as unknown as Record<string, unknown>,
      })
      .returning();

    const labelsAdded: string[] = [];
    for (const key of report.labels_to_set) {
      const label = byKey.get(key)!;
      await tx
        .insert(workItemLabels)
        .values({
          workItemId: item.id,
          labelId: label.id,
          setByActor: ctx.actor,
        })
        .onConflictDoNothing();
      labelsAdded.push(key);
      await emit(tx, {
        orgId: ctx.orgId,
        projectId: item.projectId,
        type: 'label.agent_set',
        subjectType: 'work_item',
        subjectId: item.id,
        actor: ctx.actor,
        payload: { labelKey: key },
      });
    }

    let questionsCreated = 0;
    for (const q of report.questions) {
      const qid = newId();
      await tx.insert(questions).values({
        id: qid,
        workItemId: item.id,
        runId,
        stageInstanceId: run.stageInstanceId,
        text: q.text,
        options: q.options,
        blocking: q.blocking,
        status: 'open',
      });
      questionsCreated += 1;
      await emit(tx, {
        orgId: ctx.orgId,
        projectId: item.projectId,
        type: 'question.asked',
        subjectType: 'question',
        subjectId: qid,
        actor: ctx.actor,
        payload: { blocking: q.blocking, text: q.text.slice(0, 200) },
      });
    }

    let artifacts = 0;
    for (const a of report.artifact_refs) {
      await tx.insert(artifactRefs).values({
        id: newId(),
        workItemId: item.id,
        runId,
        kind: a.kind,
        url: a.url,
        title: a.title ?? null,
      });
      artifacts += 1;
      await emit(tx, {
        orgId: ctx.orgId,
        projectId: item.projectId,
        type: 'artifact_ref.attached',
        subjectType: 'work_item',
        subjectId: item.id,
        actor: ctx.actor,
        payload: { kind: a.kind, url: a.url },
      });
    }

    await tx
      .update(runs)
      .set({ outcome: report.outcome })
      .where(eq(runs.id, runId));

    await tx
      .update(stageInstances)
      .set({ outcome: report.outcome })
      .where(eq(stageInstances.id, run.stageInstanceId));

    await tx
      .update(workItems)
      .set({
        lastReportId: reportId,
        version: item.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, item.id));

    await emit(tx, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'stage_report.posted',
      subjectType: 'stage_report',
      subjectId: reportId,
      actor: ctx.actor,
      payload: {
        runId,
        outcome: report.outcome,
        headline: report.headline,
        labelsAdded,
        questionsCreated,
        artifacts,
      },
    });

    return {
      report: row!,
      alreadyPosted: false,
      applied: { labelsAdded, questionsCreated, artifacts },
    };
  });

  // Optionally promote acceptance criteria into a new spec version when provided.
  if (report.acceptance_criteria.length > 0) {
    await createSpecVersion(
      ctx,
      item.id,
      {
        summary: report.summary || report.headline,
        acceptanceCriteria: report.acceptance_criteria,
      },
      'From stage report acceptance_criteria',
    );
  }

  return ok(result);
}

export async function listStageReports(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Result<StageReport[], CoreError>> {
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
  const rows = await ctx.db.query.stageReports.findMany({
    where: eq(stageReports.workItemId, workItemId),
    orderBy: [desc(stageReports.createdAt)],
  });
  return ok(rows);
}
