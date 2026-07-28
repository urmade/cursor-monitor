import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AddGoldenCaseInputSchema,
  RubricCriteriaSchema,
  type RubricCriterion,
} from '@nexus/contracts';
import {
  newId,
  rubricGoldenCases,
  rubricRegressionRuns,
  rubricVerdicts,
  rubrics,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { getRubric } from './crud';
import { evaluateRubric } from './evaluate';

export type GoldenCase = typeof rubricGoldenCases.$inferSelect;
export type RegressionRun = typeof rubricRegressionRuns.$inferSelect;

export async function addGoldenCase(
  ctx: ServiceContext,
  inputRaw: unknown,
): Promise<Result<GoldenCase, CoreError>> {
  const parsed = AddGoldenCaseInputSchema.safeParse(inputRaw);
  if (!parsed.success) {
    return err(
      coreError('validation', 'Invalid golden case', {
        issues: parsed.error.flatten(),
      }),
    );
  }
  const input = parsed.data;
  const rubric = await getRubric(ctx, input.rubricId);
  if (!rubric.ok) return rubric;

  const role = await getProjectRole(ctx, rubric.value.projectId);
  if (
    !can(ctx.actor, 'project.manage_gates', {
      type: 'project',
      projectId: rubric.value.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage golden cases'));
  }

  let content = input.content;
  if (input.fromVerdictId) {
    const verdict = await ctx.db.query.rubricVerdicts.findFirst({
      where: eq(rubricVerdicts.id, input.fromVerdictId),
    });
    if (!verdict) return err(coreError('not_found', 'Verdict not found'));
    // Reconstruct artefact from target — prefer stored raw snapshot if present
    if (verdict.targetKind === 'spec') {
      const { specVersions } = await import('@nexus/db');
      const spec = await ctx.db.query.specVersions.findFirst({
        where: eq(specVersions.id, verdict.targetRef),
      });
      content = (spec?.content as Record<string, unknown>) ?? { note: 'missing' };
    } else {
      const { stageReports } = await import('@nexus/db');
      const report = await ctx.db.query.stageReports.findFirst({
        where: eq(stageReports.id, verdict.targetRef),
      });
      content = report
        ? {
            outcome: report.outcome,
            headline: report.headline,
            summary: report.summary,
            confidence: report.confidence,
            not_verified: report.notVerified,
            assumptions: report.assumptions,
          }
        : { note: 'missing' };
    }
  }

  if (!content) {
    return err(coreError('validation', 'content or fromVerdictId required'));
  }

  const id = newId();
  const [row] = await ctx.db
    .insert(rubricGoldenCases)
    .values({
      id,
      rubricId: input.rubricId,
      label: input.label,
      content,
      expectedOutcome: input.expectedOutcome,
      note: input.note ?? null,
      createdByUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
    })
    .returning();
  return ok(row!);
}

export async function listGoldenCases(
  ctx: ServiceContext,
  rubricId: string,
): Promise<Result<GoldenCase[], CoreError>> {
  const rubric = await getRubric(ctx, rubricId);
  if (!rubric.ok) return rubric;

  // Include cases from all versions of the same named rubric
  const versions = await ctx.db.query.rubrics.findMany({
    where: and(
      eq(rubrics.projectId, rubric.value.projectId),
      eq(rubrics.name, rubric.value.name),
    ),
  });
  const ids = versions.map((v) => v.id);
  const rows = await ctx.db.query.rubricGoldenCases.findMany({
    where: inArray(rubricGoldenCases.rubricId, ids),
    orderBy: [desc(rubricGoldenCases.createdAt)],
  });
  // Stable ascending order for regression (oldest first) so fixture queues align.
  return ok([...rows].reverse());
}

export type RegressionResult = {
  run: RegressionRun;
  matchRate: number;
  perCriterion: Record<string, { matched: number; total: number }>;
  estimatedCostMicroUsd: bigint;
};

/**
 * Run every golden case against a rubric version using the configured provider
 * (fixture in CI). Reports match rate overall and per criterion.
 */
export async function runGoldenSet(
  ctx: ServiceContext,
  rubricId: string,
  version?: number,
  opts?: { workItemId: string },
): Promise<Result<RegressionResult, CoreError>> {
  let rubric = await getRubric(ctx, rubricId);
  if (!rubric.ok) return rubric;

  if (version != null && rubric.value.version !== version) {
    const match = await ctx.db.query.rubrics.findFirst({
      where: and(
        eq(rubrics.projectId, rubric.value.projectId),
        eq(rubrics.name, rubric.value.name),
        eq(rubrics.version, version),
      ),
    });
    if (!match) return err(coreError('not_found', 'Rubric version not found'));
    rubric = ok(match);
  }

  const role = await getProjectRole(ctx, rubric.value.projectId);
  if (
    !can(ctx.actor, 'project.manage_gates', {
      type: 'project',
      projectId: rubric.value.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot run golden set'));
  }

  const casesR = await listGoldenCases(ctx, rubric.value.id);
  if (!casesR.ok) return casesR;
  const cases = casesR.value;
  if (cases.length === 0) {
    return err(coreError('validation', 'No golden cases for this rubric'));
  }

  // Need a work item in the same project for cost attribution / budget checks.
  let workItemId = opts?.workItemId;
  if (!workItemId) {
    const { workItems } = await import('@nexus/db');
    const { isNull } = await import('drizzle-orm');
    const item = await ctx.db.query.workItems.findFirst({
      where: and(
        eq(workItems.projectId, rubric.value.projectId),
        isNull(workItems.archivedAt),
      ),
    });
    if (!item) {
      return err(
        coreError(
          'validation',
          'Golden set requires at least one work item in the project for cost attribution',
        ),
      );
    }
    workItemId = item.id;
  }

  const criteria = RubricCriteriaSchema.parse(
    rubric.value.criteria,
  ) as RubricCriterion[];
  const results: Array<Record<string, unknown>> = [];
  const perCriterion: Record<string, { matched: number; total: number }> = {};
  for (const c of criteria) {
    perCriterion[c.key] = { matched: 0, total: 0 };
  }

  let matched = 0;
  let costMicro = BigInt(0);

  for (const gc of cases) {
    const evaluated = await evaluateRubric(ctx, {
      rubricId: rubric.value.id,
      workItemId,
      skipCache: true,
      artefactOverride: {
        json: JSON.stringify(gc.content),
        targetKind: rubric.value.target,
      },
    });

    if (!evaluated.ok) {
      results.push({
        caseId: gc.id,
        label: gc.label,
        expected: gc.expectedOutcome,
        actual: 'error',
        matched: false,
        error: evaluated.error.message,
      });
      continue;
    }

    const { outcome, verdict, stored } = evaluated.value;
    costMicro += stored.costMicroUsd ?? BigInt(0);

    if (verdict) {
      for (const c of verdict.criteria) {
        if (!perCriterion[c.key]) {
          perCriterion[c.key] = { matched: 0, total: 0 };
        }
        perCriterion[c.key]!.total += 1;
        const expected = gc.expectedOutcome;
        if (expected === 'pass' && c.met === 'yes') {
          perCriterion[c.key]!.matched += 1;
        } else if (expected === 'block' && c.met === 'no') {
          perCriterion[c.key]!.matched += 1;
        } else if (expected === 'warn' && c.met === 'unclear') {
          perCriterion[c.key]!.matched += 1;
        }
      }
    }

    const okMatch = outcome === gc.expectedOutcome;
    if (okMatch) matched += 1;
    results.push({
      caseId: gc.id,
      label: gc.label,
      expected: gc.expectedOutcome,
      actual: outcome,
      matched: okMatch,
      verdictId: stored.id,
      criteria: verdict?.criteria.map((c) => ({ key: c.key, met: c.met })) ?? [],
      note:
        gc.label === 'injection'
          ? 'documents untrusted fencing; fixture supplies expected outcome'
          : undefined,
    });
  }

  const id = newId();
  const [run] = await ctx.db
    .insert(rubricRegressionRuns)
    .values({
      id,
      rubricId: rubric.value.id,
      rubricVersion: rubric.value.version,
      total: cases.length,
      matched,
      results,
      costMicroUsd: costMicro,
    })
    .returning();

  return ok({
    run: run!,
    matchRate: cases.length === 0 ? 0 : matched / cases.length,
    perCriterion,
    estimatedCostMicroUsd: costMicro,
  });
}

export async function estimateGoldenSetCost(
  ctx: ServiceContext,
  rubricId: string,
): Promise<Result<{ cases: number; estimatedCostMicroUsd: bigint }, CoreError>> {
  const casesR = await listGoldenCases(ctx, rubricId);
  if (!casesR.ok) return casesR;
  const rubric = await getRubric(ctx, rubricId);
  if (!rubric.ok) return rubric;
  const { estimateMicroFromTokens } = await import('./evaluate');
  const perCase = estimateMicroFromTokens(rubric.value.model, {
    input: 800,
    output: 400,
  });
  return ok({
    cases: casesR.value.length,
    estimatedCostMicroUsd: perCase * BigInt(casesR.value.length),
  });
}
