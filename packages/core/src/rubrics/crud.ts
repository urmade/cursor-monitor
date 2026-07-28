import { and, desc, eq, isNull, type InferSelectModel } from 'drizzle-orm';
import {
  CreateRubricInputSchema,
  RubricCriteriaSchema,
  type CreateRubricInput,
} from '@nexus/contracts';
import { newId, rubrics } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { describeRubric } from './prompt';

export type Rubric = InferSelectModel<typeof rubrics>;

export { describeRubric };

async function requireRubricWrite(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<void, CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.manage_gates', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage rubrics'));
  }
  return ok(undefined);
}

export async function createRubric(
  ctx: ServiceContext,
  inputRaw: CreateRubricInput,
): Promise<Result<Rubric, CoreError>> {
  const parsed = CreateRubricInputSchema.safeParse(inputRaw);
  if (!parsed.success) {
    return err(
      coreError('validation', 'Invalid rubric', {
        issues: parsed.error.flatten(),
      }),
    );
  }
  const input = parsed.data;
  const auth = await requireRubricWrite(ctx, input.projectId);
  if (!auth.ok) return auth;

  const criteria = RubricCriteriaSchema.parse(input.criteria);
  const id = newId();
  const [row] = await ctx.db
    .insert(rubrics)
    .values({
      id,
      projectId: input.projectId,
      name: input.name,
      version: 1,
      target: input.target,
      question: input.question,
      criteria,
      passWhen: input.passWhen,
      blockWhen: input.blockWhen,
      guidance: input.guidance,
      model: input.model,
      maxOutputTokens: input.maxOutputTokens,
      uncertaintyPolicy: input.uncertaintyPolicy,
      enabled: false,
      createdByUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
    })
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: input.projectId,
    type: 'rubric.created',
    subjectType: 'rubric',
    subjectId: id,
    actor: ctx.actor,
    payload: { name: input.name, version: 1 },
  });

  return ok(row!);
}

/**
 * Updates create a new version row (same name, version+1).
 * Stored verdicts stay pinned to their rubric version id/version.
 */
export async function updateRubric(
  ctx: ServiceContext,
  input: {
    rubricId: string;
    name?: string;
    question?: string;
    criteria?: unknown;
    passWhen?: string;
    blockWhen?: string;
    guidance?: string;
    model?: string;
    maxOutputTokens?: number;
    uncertaintyPolicy?: 'warn' | 'pass' | 'block';
    target?: 'spec' | 'stage_report';
  },
): Promise<Result<Rubric, CoreError>> {
  const existing = await ctx.db.query.rubrics.findFirst({
    where: and(eq(rubrics.id, input.rubricId), isNull(rubrics.archivedAt)),
  });
  if (!existing) return err(coreError('not_found', 'Rubric not found'));

  const auth = await requireRubricWrite(ctx, existing.projectId);
  if (!auth.ok) return auth;

  const criteria = input.criteria
    ? RubricCriteriaSchema.parse(input.criteria)
    : (existing.criteria as unknown[]);

  // Find latest version for this name
  const latest = await ctx.db.query.rubrics.findFirst({
    where: and(
      eq(rubrics.projectId, existing.projectId),
      eq(rubrics.name, existing.name),
      isNull(rubrics.archivedAt),
    ),
    orderBy: [desc(rubrics.version)],
  });
  const nextVersion = (latest?.version ?? existing.version) + 1;
  const id = newId();
  const nextName = input.name ?? existing.name;

  let row: Rubric;
  try {
    const inserted = await ctx.db
      .insert(rubrics)
      .values({
        id,
        projectId: existing.projectId,
        name: nextName,
        version: nextVersion,
        target: input.target ?? existing.target,
        question: input.question ?? existing.question,
        criteria: criteria as Record<string, unknown>[],
        passWhen: input.passWhen ?? existing.passWhen,
        blockWhen: input.blockWhen ?? existing.blockWhen,
        guidance: input.guidance ?? existing.guidance,
        model: input.model ?? existing.model,
        maxOutputTokens: input.maxOutputTokens ?? existing.maxOutputTokens,
        uncertaintyPolicy: input.uncertaintyPolicy ?? existing.uncertaintyPolicy,
        enabled: false,
        createdByUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
      })
      .returning();
    row = inserted[0]!;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes('rubrics_project_name_version') ||
      msg.includes('unique') ||
      msg.includes('duplicate')
    ) {
      return err(
        coreError(
          'conflict',
          `A rubric named "${nextName}" already has this version; rename failed`,
          { cause: msg },
        ),
      );
    }
    return err(coreError('invariant', 'Failed to create rubric version', { cause: msg }));
  }

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: existing.projectId,
    type: 'rubric.version_created',
    subjectType: 'rubric',
    subjectId: id,
    actor: ctx.actor,
    payload: {
      name: row.name,
      version: nextVersion,
      priorId: existing.id,
    },
  });

  return ok(row);
}

export async function listRubrics(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<Rubric[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Project not found'));
  }

  const rows = await ctx.db.query.rubrics.findMany({
    where: and(eq(rubrics.projectId, projectId), isNull(rubrics.archivedAt)),
    orderBy: [desc(rubrics.updatedAt)],
  });

  // Latest version per name
  const byName = new Map<string, Rubric>();
  for (const r of rows) {
    const cur = byName.get(r.name);
    if (!cur || r.version > cur.version) byName.set(r.name, r);
  }
  return ok([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

export async function getRubric(
  ctx: ServiceContext,
  rubricId: string,
): Promise<Result<Rubric, CoreError>> {
  const row = await ctx.db.query.rubrics.findFirst({
    where: eq(rubrics.id, rubricId),
  });
  if (!row || row.archivedAt) {
    return err(coreError('not_found', 'Rubric not found'));
  }
  const role = await getProjectRole(ctx, row.projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId: row.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Rubric not found'));
  }
  return ok(row);
}

export async function listRubricVersions(
  ctx: ServiceContext,
  projectId: string,
  name: string,
): Promise<Result<Rubric[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Project not found'));
  }
  const rows = await ctx.db.query.rubrics.findMany({
    where: and(
      eq(rubrics.projectId, projectId),
      eq(rubrics.name, name),
      isNull(rubrics.archivedAt),
    ),
    orderBy: [desc(rubrics.version)],
  });
  return ok(rows);
}

/**
 * Enable a rubric version. Requires a regression run unless acknowledgeSkipped.
 * Enabling an enforcing agentic *gate* is owner-only (checked in gate CRUD).
 */
export async function enableRubric(
  ctx: ServiceContext,
  input: {
    rubricId: string;
    acknowledgeSkippedRegression?: boolean;
  },
): Promise<Result<Rubric, CoreError>> {
  const row = await getRubric(ctx, input.rubricId);
  if (!row.ok) return row;
  const auth = await requireRubricWrite(ctx, row.value.projectId);
  if (!auth.ok) return auth;

  const { rubricRegressionRuns, rubricGoldenCases } = await import('@nexus/db');
  const golden = await ctx.db.query.rubricGoldenCases.findMany({
    where: eq(rubricGoldenCases.rubricId, row.value.id),
  });
  // Golden cases are keyed by rubric lineage name — also check same-name siblings
  const versions = await ctx.db.query.rubrics.findMany({
    where: and(
      eq(rubrics.projectId, row.value.projectId),
      eq(rubrics.name, row.value.name),
    ),
  });
  const versionIds = versions.map((v) => v.id);
  let caseCount = golden.length;
  if (versionIds.length > 1) {
    const { inArray } = await import('drizzle-orm');
    const allCases = await ctx.db.query.rubricGoldenCases.findMany({
      where: inArray(rubricGoldenCases.rubricId, versionIds),
    });
    caseCount = allCases.length;
  }

  if (caseCount === 0 && !input.acknowledgeSkippedRegression) {
    return err(
      coreError(
        'validation',
        'Add at least one golden case and run regression before enabling, or pass acknowledgeSkippedRegression',
      ),
    );
  }

  if (caseCount > 0 && !input.acknowledgeSkippedRegression) {
    const regression = await ctx.db.query.rubricRegressionRuns.findFirst({
      where: and(
        eq(rubricRegressionRuns.rubricId, row.value.id),
        eq(rubricRegressionRuns.rubricVersion, row.value.version),
      ),
      orderBy: [desc(rubricRegressionRuns.createdAt)],
    });
    if (!regression) {
      return err(
        coreError(
          'validation',
          'Run golden-set regression before enabling, or pass acknowledgeSkippedRegression',
        ),
      );
    }
  }

  // Disable other versions of same name, enable this one
  await ctx.db
    .update(rubrics)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(rubrics.projectId, row.value.projectId),
        eq(rubrics.name, row.value.name),
      ),
    );

  const [updated] = await ctx.db
    .update(rubrics)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(rubrics.id, row.value.id))
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: row.value.projectId,
    type: 'rubric.enabled',
    subjectType: 'rubric',
    subjectId: row.value.id,
    actor: ctx.actor,
    payload: { version: row.value.version },
  });

  return ok(updated!);
}

export async function archiveRubric(
  ctx: ServiceContext,
  rubricId: string,
): Promise<Result<Rubric, CoreError>> {
  const row = await getRubric(ctx, rubricId);
  if (!row.ok) return row;
  const auth = await requireRubricWrite(ctx, row.value.projectId);
  if (!auth.ok) return auth;

  const [updated] = await ctx.db
    .update(rubrics)
    .set({
      archivedAt: new Date(),
      enabled: false,
      updatedAt: new Date(),
    })
    .where(eq(rubrics.id, rubricId))
    .returning();
  return ok(updated!);
}

/** Seeded example rubrics a project can copy. */
export const SEEDED_RUBRIC_TEMPLATES = [
  {
    name: 'Spec has testable outcomes',
    target: 'spec' as const,
    question: 'Does this spec describe testable outcomes?',
    criteria: [
      {
        key: 'testable_outcomes',
        statement:
          'Each outcome can be verified without asking the author what they meant',
        weight: 'must' as const,
      },
      {
        key: 'concrete_scope',
        statement: 'Scope is concrete — not vague phrases like "make it better"',
        weight: 'must' as const,
      },
      {
        key: 'success_signals',
        statement: 'Success signals or acceptance checks are stated or implied clearly',
        weight: 'should' as const,
      },
    ],
    passWhen: 'Outcomes are specific and independently verifiable',
    blockWhen: 'Outcomes are vague, missing, or cannot be tested without the author',
    guidance:
      'Prefer Warn when partially testable. Never infer scope from a repository.',
    uncertaintyPolicy: 'warn' as const,
  },
  {
    name: 'Report acknowledges unverified work',
    target: 'stage_report' as const,
    question: 'Does this stage report acknowledge what it did not verify?',
    criteria: [
      {
        key: 'not_verified_listed',
        statement: 'Items the agent did not verify are listed or explicitly empty',
        weight: 'must' as const,
      },
      {
        key: 'honest_confidence',
        statement: 'Confidence matches the evidence described in the report',
        weight: 'should' as const,
      },
    ],
    passWhen: 'Unverified work is acknowledged honestly',
    blockWhen: 'Report claims complete verification without evidence',
    guidance: 'Warn when confidence is high but not_verified is empty and summary is thin.',
    uncertaintyPolicy: 'warn' as const,
  },
] as const;
