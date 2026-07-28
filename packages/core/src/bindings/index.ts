import { and, desc, eq, isNull, type InferSelectModel } from 'drizzle-orm';
import {
  BindingConditionSchema,
  BindingConfigSchema,
} from '@nexus/contracts';
import {
  automationBindings,
  labels,
  newId,
  promptTemplates,
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
import { DEFAULT_PROMPT_TEMPLATE } from '../runs/prompt';

export type PromptTemplate = InferSelectModel<typeof promptTemplates>;
export type AutomationBinding = InferSelectModel<typeof automationBindings>;

export async function createPromptTemplate(
  ctx: ServiceContext,
  input: { projectId: string; name: string; body?: string },
): Promise<Result<PromptTemplate, CoreError>> {
  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'project.manage_bindings', {
      type: 'project',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage bindings'));
  }

  const latest = await ctx.db.query.promptTemplates.findFirst({
    where: and(
      eq(promptTemplates.projectId, input.projectId),
      eq(promptTemplates.name, input.name),
    ),
    orderBy: [desc(promptTemplates.version)],
  });
  const version = (latest?.version ?? 0) + 1;
  const id = newId();
  const [row] = await ctx.db
    .insert(promptTemplates)
    .values({
      id,
      projectId: input.projectId,
      name: input.name,
      version,
      body: input.body ?? DEFAULT_PROMPT_TEMPLATE,
      createdByUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
    })
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: input.projectId,
    type: 'prompt_template.created',
    subjectType: 'prompt_template',
    subjectId: id,
    actor: ctx.actor,
    payload: { name: input.name, version },
  });

  return ok(row!);
}

export async function listPromptTemplates(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<PromptTemplate[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (!can(ctx.actor, 'project.read', { type: 'project', projectId, role })) {
    return err(coreError('not_found', 'Project not found'));
  }
  const rows = await ctx.db.query.promptTemplates.findMany({
    where: eq(promptTemplates.projectId, projectId),
    orderBy: [desc(promptTemplates.createdAt)],
  });
  return ok(rows);
}

export async function upsertBinding(
  ctx: ServiceContext,
  input: {
    id?: string;
    projectId: string;
    stageId: string;
    name: string;
    adapter: 'cloud_agent' | 'automation_webhook';
    condition?: unknown;
    priority?: number;
    config: unknown;
    promptTemplateId?: string | null;
    enabled?: boolean;
  },
): Promise<Result<AutomationBinding, CoreError>> {
  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'project.manage_bindings', {
      type: 'project',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage bindings'));
  }

  const stage = await ctx.db.query.stages.findFirst({
    where: and(
      eq(stages.id, input.stageId),
      eq(stages.projectId, input.projectId),
      isNull(stages.archivedAt),
    ),
  });
  if (!stage) return err(coreError('not_found', 'Stage not found'));

  const configParsed = BindingConfigSchema.safeParse({
    ...(typeof input.config === 'object' && input.config !== null
      ? input.config
      : {}),
    adapter: input.adapter,
  });
  if (!configParsed.success) {
    return err(
      coreError('validation', 'Invalid binding config', {
        issues: configParsed.error.flatten(),
      }),
    );
  }

  const conditionParsed = BindingConditionSchema.safeParse(
    input.condition ?? null,
  );
  if (!conditionParsed.success) {
    return err(coreError('validation', 'Invalid binding condition'));
  }

  if (input.id) {
    const existing = await ctx.db.query.automationBindings.findFirst({
      where: eq(automationBindings.id, input.id),
    });
    if (!existing || existing.projectId !== input.projectId) {
      return err(coreError('not_found', 'Binding not found'));
    }
    const [updated] = await ctx.db
      .update(automationBindings)
      .set({
        stageId: input.stageId,
        name: input.name,
        adapter: input.adapter,
        condition: conditionParsed.data,
        priority: input.priority ?? existing.priority,
        config: configParsed.data,
        promptTemplateId:
          input.promptTemplateId === undefined
            ? existing.promptTemplateId
            : input.promptTemplateId,
        enabled: input.enabled ?? existing.enabled,
        updatedAt: new Date(),
      })
      .where(eq(automationBindings.id, input.id))
      .returning();
    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: input.projectId,
      type: 'binding.updated',
      subjectType: 'automation_binding',
      subjectId: input.id,
      actor: ctx.actor,
      payload: { name: input.name, stageId: input.stageId },
    });
    return ok(updated!);
  }

  const id = newId();
  const [created] = await ctx.db
    .insert(automationBindings)
    .values({
      id,
      projectId: input.projectId,
      stageId: input.stageId,
      name: input.name,
      adapter: input.adapter,
      condition: conditionParsed.data,
      priority: input.priority ?? 0,
      config: configParsed.data,
      promptTemplateId: input.promptTemplateId ?? null,
      enabled: input.enabled ?? true,
    })
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: input.projectId,
    type: 'binding.created',
    subjectType: 'automation_binding',
    subjectId: id,
    actor: ctx.actor,
    payload: { name: input.name, stageId: input.stageId, adapter: input.adapter },
  });

  return ok(created!);
}

export async function listBindings(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<AutomationBinding[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (!can(ctx.actor, 'project.read', { type: 'project', projectId, role })) {
    return err(coreError('not_found', 'Project not found'));
  }
  const rows = await ctx.db.query.automationBindings.findMany({
    where: and(
      eq(automationBindings.projectId, projectId),
      isNull(automationBindings.archivedAt),
    ),
    orderBy: [desc(automationBindings.priority)],
  });
  return ok(rows);
}

export async function archiveBinding(
  ctx: ServiceContext,
  bindingId: string,
): Promise<Result<void, CoreError>> {
  const existing = await ctx.db.query.automationBindings.findFirst({
    where: eq(automationBindings.id, bindingId),
  });
  if (!existing || existing.archivedAt) {
    return err(coreError('not_found', 'Binding not found'));
  }
  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'project.manage_bindings', {
      type: 'project',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage bindings'));
  }
  await ctx.db
    .update(automationBindings)
    .set({ archivedAt: new Date(), enabled: false, updatedAt: new Date() })
    .where(eq(automationBindings.id, bindingId));
  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: existing.projectId,
    type: 'binding.archived',
    subjectType: 'automation_binding',
    subjectId: bindingId,
    actor: ctx.actor,
    payload: { name: existing.name },
  });
  return ok(undefined);
}

function conditionMatches(
  condition: unknown,
  facts: {
    labelKeys: string[];
    complexity: string | null;
  },
): boolean {
  if (condition == null) return true;
  const parsed = BindingConditionSchema.safeParse(condition);
  if (!parsed.success || !parsed.data) return true;
  const c = parsed.data;
  if (c.complexity?.length) {
    if (!facts.complexity || !c.complexity.includes(facts.complexity as 'low')) {
      return false;
    }
  }
  if (c.labelKeysAll?.length) {
    for (const k of c.labelKeysAll) {
      if (!facts.labelKeys.includes(k)) return false;
    }
  }
  if (c.labelKeysAny?.length) {
    if (!c.labelKeysAny.some((k) => facts.labelKeys.includes(k))) return false;
  }
  return true;
}

export type ResolveBindingResult = {
  binding: AutomationBinding | null;
  reason: string;
  candidates: Array<{ id: string; name: string; matched: boolean; reason: string }>;
};

export async function resolveBinding(
  ctx: ServiceContext,
  input: { workItemId: string; stageId?: string },
): Promise<Result<ResolveBindingResult, CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, input.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const stageId = input.stageId ?? item.currentStageId;
  const bindings = await ctx.db.query.automationBindings.findMany({
    where: and(
      eq(automationBindings.projectId, item.projectId),
      eq(automationBindings.stageId, stageId),
      eq(automationBindings.enabled, true),
      isNull(automationBindings.archivedAt),
    ),
    orderBy: [desc(automationBindings.priority)],
  });

  const labelRows = await ctx.db
    .select({ key: labels.key })
    .from(workItemLabels)
    .innerJoin(labels, eq(labels.id, workItemLabels.labelId))
    .where(eq(workItemLabels.workItemId, item.id));
  const labelKeys = labelRows.map((r) => r.key);
  const facts = { labelKeys, complexity: item.complexity };

  const candidates = bindings.map((b) => {
    const matched = conditionMatches(b.condition, facts);
    return {
      id: b.id,
      name: b.name,
      matched,
      reason: matched
        ? `priority ${b.priority}; condition matched`
        : `priority ${b.priority}; condition did not match`,
    };
  });

  const winner = bindings.find((b) => conditionMatches(b.condition, facts));
  if (!winner) {
    return ok({
      binding: null,
      reason: bindings.length
        ? 'No enabled binding matched conditions'
        : 'No enabled bindings for this stage',
      candidates,
    });
  }

  return ok({
    binding: winner,
    reason: `Selected "${winner.name}" (priority ${winner.priority})`,
    candidates,
  });
}
