import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  CreateProjectInputSchema,
  type ProjectTemplate,
} from '@nexus/contracts';
import type { InferSelectModel } from 'drizzle-orm';
import {
  labels,
  newId,
  projectMembers,
  projects,
  stages,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { err, ok, type Result } from '../result';
import {
  LABEL_TAXONOMY_TEMPLATES,
  PIPELINE_TEMPLATES,
} from './templates';

export type Project = InferSelectModel<typeof projects>;

function taxonomyForTemplate(template: ProjectTemplate) {
  if (template === 'minimal') return LABEL_TAXONOMY_TEMPLATES.product;
  if (template === 'empty') return [];
  return LABEL_TAXONOMY_TEMPLATES.risk_touches;
}

export async function createProject(
  ctx: ServiceContext,
  raw: unknown,
): Promise<Result<Project, CoreError>> {
  if (!can(ctx.actor, 'project.create', { type: 'org', orgId: ctx.orgId })) {
    return err(coreError('forbidden', 'Cannot create project'));
  }
  if (ctx.actor.kind !== 'human') {
    return err(coreError('forbidden', 'Only humans can create projects in Phase 1'));
  }

  const input = CreateProjectInputSchema.parse(raw);
  const pipeline = PIPELINE_TEMPLATES[input.template];
  const taxonomy = taxonomyForTemplate(input.template);

  if (input.template !== 'empty' && !pipeline.some((s) => s.isInitial)) {
    return err(coreError('invariant', 'Template missing initial stage'));
  }

  const projectId = newId();

  const project = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({
        id: projectId,
        orgId: ctx.orgId,
        key: input.key,
        name: input.name,
        description: input.description ?? '',
        ownerUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
      })
      .returning();

    await tx.insert(projectMembers).values({
      projectId,
      userId: ctx.actor.kind === 'human' ? ctx.actor.userId : '',
      role: 'owner',
    });

    for (const s of pipeline) {
      await tx.insert(stages).values({
        id: newId(),
        projectId,
        key: s.key,
        name: s.name,
        position: s.position,
        defaultOwnerClass: s.defaultOwnerClass,
        isInitial: s.isInitial,
        isTerminal: s.isTerminal,
      });
    }

    for (const l of taxonomy) {
      await tx.insert(labels).values({
        id: newId(),
        projectId,
        key: l.key,
        name: l.name,
        color: l.color,
        category: l.category,
        agentSettable: l.agentSettable,
      });
    }

    // Seed loop reason taxonomy in the same transaction so a failed seed
    // cannot leave a project that can never record a return.
    const { seedDefaultReasonCodes } = await import('../loops/reasons');
    await seedDefaultReasonCodes(tx, projectId);

    await emit(tx, {
      orgId: ctx.orgId,
      projectId,
      type: 'project.created',
      subjectType: 'project',
      subjectId: projectId,
      actor: ctx.actor,
      payload: {
        key: input.key,
        name: input.name,
        template: input.template,
        stageCount: pipeline.length,
        labelCount: taxonomy.length,
      },
    });

    return row!;
  });

  return ok(project);
}

export async function listProjects(
  ctx: ServiceContext,
): Promise<Result<Project[], CoreError>> {
  if (ctx.actor.kind !== 'human') {
    return err(coreError('forbidden', 'Human actor required'));
  }

  const memberships = await ctx.db.query.projectMembers.findMany({
    where: eq(projectMembers.userId, ctx.actor.userId),
  });
  const ids = memberships.map((m) => m.projectId);
  if (ids.length === 0) return ok([]);

  const rows = await ctx.db.query.projects.findMany({
    where: and(eq(projects.orgId, ctx.orgId), isNull(projects.archivedAt)),
    orderBy: [asc(projects.key)],
  });
  return ok(rows.filter((p) => ids.includes(p.id)));
}

export async function getProjectByKey(
  ctx: ServiceContext,
  key: string,
): Promise<Result<Project, CoreError>> {
  const project = await ctx.db.query.projects.findFirst({
    where: and(eq(projects.orgId, ctx.orgId), eq(projects.key, key)),
  });
  if (!project || project.archivedAt) {
    return err(coreError('not_found', 'Project not found'));
  }

  const { getProjectRole } = await import('./members');
  const role = await getProjectRole(ctx, project.id);
  if (!can(ctx.actor, 'project.read', { type: 'project', projectId: project.id, role })) {
    // Cross-project isolation: 404, not 403
    return err(coreError('not_found', 'Project not found'));
  }
  return ok(project);
}

export async function updateProject(
  ctx: ServiceContext,
  id: string,
  patch: {
    name?: string;
    description?: string;
    settings?: Record<string, unknown>;
    optionalConcepts?: Record<string, unknown>;
  },
): Promise<Result<Project, CoreError>> {
  const { getProjectRole } = await import('./members');
  const role = await getProjectRole(ctx, id);
  if (!can(ctx.actor, 'project.update', { type: 'project', projectId: id, role })) {
    return err(coreError('forbidden', 'Cannot update project'));
  }

  const existing = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, id),
  });
  if (!existing) return err(coreError('not_found', 'Project not found'));

  const nextSettings = patch.settings
    ? { ...(existing.settings as Record<string, unknown>), ...patch.settings }
    : undefined;

  let nextConcepts: Record<string, unknown> | undefined;
  if (patch.optionalConcepts !== undefined) {
    const { normalizeOptionalConcepts } = await import(
      '../rubrics/optional-concepts'
    );
    const existingNorm = normalizeOptionalConcepts(existing.optionalConcepts);
    // Merge enabled toggles into the structured form so requiredAtStageId /
    // evidenceKinds survive a settings form that only posts booleans.
    const mergedRaw: Record<string, unknown> = {
      acceptanceCriteria: existingNorm.acceptanceCriteria,
      visualConfirmation: existingNorm.visualConfirmation,
    };
    if ('acceptanceCriteria' in patch.optionalConcepts) {
      const ac = patch.optionalConcepts.acceptanceCriteria;
      if (typeof ac === 'boolean') {
        mergedRaw.acceptanceCriteria = {
          ...existingNorm.acceptanceCriteria,
          enabled: ac,
        };
      } else if (ac && typeof ac === 'object') {
        mergedRaw.acceptanceCriteria = {
          ...existingNorm.acceptanceCriteria,
          ...(ac as Record<string, unknown>),
        };
      }
    }
    if ('visualConfirmation' in patch.optionalConcepts) {
      const vc = patch.optionalConcepts.visualConfirmation;
      if (typeof vc === 'boolean') {
        mergedRaw.visualConfirmation = {
          ...existingNorm.visualConfirmation,
          enabled: vc,
        };
      } else if (vc && typeof vc === 'object') {
        mergedRaw.visualConfirmation = {
          ...existingNorm.visualConfirmation,
          ...(vc as Record<string, unknown>),
        };
      }
    }
    const n = normalizeOptionalConcepts(mergedRaw);
    nextConcepts = {
      acceptanceCriteria: n.acceptanceCriteria.enabled
        ? n.acceptanceCriteria
        : false,
      visualConfirmation: n.visualConfirmation.enabled
        ? {
            enabled: true,
            evidenceKinds: n.visualConfirmation.evidenceKinds,
            ...(n.visualConfirmation.requiredAtStageId
              ? { requiredAtStageId: n.visualConfirmation.requiredAtStageId }
              : {}),
          }
        : false,
    };
  }

  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(projects)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(nextSettings !== undefined ? { settings: nextSettings } : {}),
        ...(nextConcepts !== undefined ? { optionalConcepts: nextConcepts } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();
    if (!row) return null;
    await emit(tx, {
      orgId: ctx.orgId,
      projectId: id,
      type: 'project.updated',
      subjectType: 'project',
      subjectId: id,
      actor: ctx.actor,
      payload: patch,
    });
    return row;
  });

  if (!updated) return err(coreError('not_found', 'Project not found'));
  return ok(updated);
}
