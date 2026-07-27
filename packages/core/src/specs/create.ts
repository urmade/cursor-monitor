import { and, desc, eq, isNull, type InferSelectModel } from 'drizzle-orm';
import { SpecContentSchema } from '@nexus/contracts';
import { newId, projects, specVersions, workItems } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';

export type SpecVersion = InferSelectModel<typeof specVersions>;

export async function createSpecVersion(
  ctx: ServiceContext,
  workItemId: string,
  contentRaw: unknown,
  note?: string,
): Promise<Result<SpecVersion, CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, workItemId), isNull(workItems.archivedAt)),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'spec.write', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot write specs'));
  }

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, item.projectId),
  });
  if (!project) return err(coreError('not_found', 'Project not found'));

  const parsed = SpecContentSchema.safeParse(contentRaw);
  if (!parsed.success) {
    return err(
      coreError('validation', 'Invalid spec content', {
        issues: parsed.error.flatten(),
      }),
    );
  }

  // Acceptance criteria only surfaced when project enables the optional concept (P7).
  // Phase 1 accepts the field if present but does not require it.
  const content = { ...parsed.data };
  if (!project.optionalConcepts?.acceptanceCriteria) {
    // Keep data if provided; UI simply does not prompt for it.
  }

  const byteSize = Buffer.byteLength(JSON.stringify(content), 'utf8');
  if (byteSize > 100_000) {
    return err(coreError('validation', 'Spec content exceeds 100KB limit'));
  }

  const version = await ctx.db.transaction(async (tx) => {
    const latest = await tx.query.specVersions.findFirst({
      where: eq(specVersions.workItemId, workItemId),
      orderBy: [desc(specVersions.version)],
    });
    const nextVersion = (latest?.version ?? 0) + 1;
    const id = newId();

    const [row] = await tx
      .insert(specVersions)
      .values({
        id,
        workItemId,
        version: nextVersion,
        content,
        authoredBy: ctx.actor,
        note: note ?? null,
      })
      .returning();

    await tx
      .update(workItems)
      .set({
        currentSpecVersionId: id,
        version: item.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, workItemId));

    await emit(tx, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'spec.version_created',
      subjectType: 'spec_version',
      subjectId: id,
      actor: ctx.actor,
      payload: {
        workItemId,
        version: nextVersion,
        note: note ?? null,
      },
    });

    return row!;
  });

  return ok(version);
}

export async function getSpec(
  ctx: ServiceContext,
  workItemId: string,
  version?: number,
): Promise<Result<SpecVersion, CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'spec.read', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Work item not found'));
  }

  if (version !== undefined) {
    const row = await ctx.db.query.specVersions.findFirst({
      where: and(
        eq(specVersions.workItemId, workItemId),
        eq(specVersions.version, version),
      ),
    });
    if (!row) return err(coreError('not_found', 'Spec version not found'));
    return ok(row);
  }

  if (!item.currentSpecVersionId) {
    return err(coreError('not_found', 'No spec yet'));
  }

  const current = await ctx.db.query.specVersions.findFirst({
    where: eq(specVersions.id, item.currentSpecVersionId),
  });
  if (!current) return err(coreError('not_found', 'Spec version not found'));
  return ok(current);
}

export async function listSpecVersions(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Result<SpecVersion[], CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'spec.read', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Work item not found'));
  }

  const rows = await ctx.db.query.specVersions.findMany({
    where: eq(specVersions.workItemId, workItemId),
    orderBy: [desc(specVersions.version)],
  });
  return ok(rows);
}
