import { and, desc, eq, inArray, isNull, type InferSelectModel } from 'drizzle-orm';
import {
  CONDITION_MAX_DEPTH,
  ConditionEnvelopeSchema,
  FieldRuleConfigSchema,
  GATES_PER_PROJECT_CAP,
  GateTriggerSchema,
  HumanApprovalConfigSchema,
  BudgetConfigSchema,
  AgenticConfigSchema,
  conditionDepth,
  unwrapCondition,
  type GateEvaluatorKind,
  type GateTrigger,
  type ProjectRole,
} from '@nexus/contracts';
import { gates, newId, projectMembers, stages } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { ensureDefaultEvaluatorsRegistered } from './evaluators';

ensureDefaultEvaluatorsRegistered();

export type Gate = InferSelectModel<typeof gates>;

function parseConfig(
  evaluator: GateEvaluatorKind,
  config: unknown,
): Result<Record<string, unknown>, CoreError> {
  let parsed;
  switch (evaluator) {
    case 'field_rule':
      parsed = FieldRuleConfigSchema.safeParse(config);
      break;
    case 'human_approval':
      parsed = HumanApprovalConfigSchema.safeParse(config);
      break;
    case 'budget':
      parsed = BudgetConfigSchema.safeParse(config ?? {});
      break;
    case 'agentic':
      parsed = AgenticConfigSchema.safeParse(config ?? {});
      break;
    default:
      return err(coreError('validation', `Unknown evaluator: ${evaluator}`));
  }
  if (!parsed.success) {
    return err(
      coreError('validation', 'Invalid gate config', {
        issues: parsed.error.flatten(),
      }),
    );
  }
  return ok(parsed.data as Record<string, unknown>);
}

function validateAppliesWhen(appliesWhen: unknown): Result<unknown, CoreError> {
  if (appliesWhen == null) return ok(null);
  const env = ConditionEnvelopeSchema.safeParse(appliesWhen);
  if (!env.success) {
    // Allow bare AST wrapped on write
    const ast = unwrapCondition(appliesWhen);
    if (!ast) {
      return err(coreError('validation', 'Invalid appliesWhen condition'));
    }
    if (conditionDepth(ast) > CONDITION_MAX_DEPTH) {
      return err(
        coreError(
          'validation',
          `Condition deeper than ${CONDITION_MAX_DEPTH} levels`,
        ),
      );
    }
    return ok({ v: 1, ast });
  }
  if (conditionDepth(env.data.ast) > CONDITION_MAX_DEPTH) {
    return err(
      coreError(
        'validation',
        `Condition deeper than ${CONDITION_MAX_DEPTH} levels`,
      ),
    );
  }
  return ok(env.data);
}

export async function createGate(
  ctx: ServiceContext,
  input: {
    projectId: string;
    name: string;
    description?: string;
    evaluator: GateEvaluatorKind;
    trigger: GateTrigger;
    appliesWhen?: unknown | null;
    config: unknown;
    onFailure?: 'block' | 'warn';
    enabled?: boolean;
  },
): Promise<Result<Gate, CoreError>> {
  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'project.manage_gates', {
      type: 'project',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage gates'));
  }

  const existing = await ctx.db.query.gates.findMany({
    where: and(eq(gates.projectId, input.projectId), isNull(gates.archivedAt)),
  });
  if (existing.length >= GATES_PER_PROJECT_CAP) {
    return err(
      coreError(
        'validation',
        `At most ${GATES_PER_PROJECT_CAP} gates per project`,
      ),
    );
  }

  const trigger = GateTriggerSchema.safeParse(input.trigger);
  if (!trigger.success) {
    return err(
      coreError('validation', 'Invalid gate trigger', {
        issues: trigger.error.flatten(),
      }),
    );
  }

  const config = parseConfig(input.evaluator, input.config);
  if (!config.ok) return config;

  // toStageId / stageId on trigger must belong to this project
  const trig = trigger.data;
  if (trig.kind === 'on_transition' && trig.toStageId) {
    const stage = await ctx.db.query.stages.findFirst({
      where: and(
        eq(stages.id, trig.toStageId),
        eq(stages.projectId, input.projectId),
        isNull(stages.archivedAt),
      ),
    });
    if (!stage) {
      return err(
        coreError('validation', 'trigger.toStageId must belong to this project'),
      );
    }
  }
  if (trig.kind === 'on_run_finished' && trig.stageId) {
    const stage = await ctx.db.query.stages.findFirst({
      where: and(
        eq(stages.id, trig.stageId),
        eq(stages.projectId, input.projectId),
        isNull(stages.archivedAt),
      ),
    });
    if (!stage) {
      return err(
        coreError('validation', 'trigger.stageId must belong to this project'),
      );
    }
  }

  // Harden field_rule require + warnWhen depth
  if (input.evaluator === 'field_rule') {
    const requireAst = (config.value as { require: unknown }).require;
    const depth = conditionDepth(
      requireAst as import('@nexus/contracts').ConditionAst,
    );
    if (depth > CONDITION_MAX_DEPTH) {
      return err(
        coreError(
          'validation',
          `Condition deeper than ${CONDITION_MAX_DEPTH} levels`,
        ),
      );
    }
    const warnWhen = (config.value as { warnWhen?: unknown }).warnWhen;
    if (warnWhen) {
      const warnDepth = conditionDepth(
        warnWhen as import('@nexus/contracts').ConditionAst,
      );
      if (warnDepth > CONDITION_MAX_DEPTH) {
        return err(
          coreError(
            'validation',
            `warnWhen deeper than ${CONDITION_MAX_DEPTH} levels`,
          ),
        );
      }
    }
  }

  // Approval deadlock mitigation: at least one project member matches approverRoles
  if (input.evaluator === 'human_approval') {
    const roles = (config.value as { approverRoles: ProjectRole[] }).approverRoles;
    const members = await ctx.db.query.projectMembers.findMany({
      where: and(
        eq(projectMembers.projectId, input.projectId),
        inArray(projectMembers.role, roles),
      ),
    });
    if (members.length === 0) {
      return err(
        coreError(
          'validation',
          `No project member has an approver role (${roles.join(', ')}) — approval would deadlock`,
        ),
      );
    }
  }

  const applies = validateAppliesWhen(input.appliesWhen ?? null);
  if (!applies.ok) return applies;

  // Contradiction warning: two gates on same trigger with opposite on_failure — soft check
  const sameTrigger = existing.filter((g) => {
    const t = g.trigger as GateTrigger;
    return t.kind === trigger.data.kind;
  });
  const contradictionHint =
    sameTrigger.length > 0 &&
    sameTrigger.some((g) => g.onFailure !== (input.onFailure ?? 'block'));

  const id = newId();
  const [row] = await ctx.db
    .insert(gates)
    .values({
      id,
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? '',
      evaluator: input.evaluator,
      trigger: trigger.data,
      appliesWhen: (applies.value as Record<string, unknown> | null) ?? null,
      config: config.value,
      onFailure: input.onFailure ?? 'block',
      // Created disabled by default — enabling is a deliberate second action.
      enabled: input.enabled ?? false,
      version: 1,
      createdByUserId: ctx.actor.kind === 'human' ? ctx.actor.userId : null,
    })
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: input.projectId,
    type: 'gate.created',
    subjectType: 'gate',
    subjectId: id,
    actor: ctx.actor,
    payload: {
      name: input.name,
      evaluator: input.evaluator,
      enabled: row!.enabled,
      contradictionHint: contradictionHint || undefined,
    },
  });

  return ok(row!);
}

export async function updateGate(
  ctx: ServiceContext,
  gateId: string,
  patch: {
    name?: string;
    description?: string;
    trigger?: GateTrigger;
    appliesWhen?: unknown | null;
    config?: unknown;
    onFailure?: 'block' | 'warn';
    enabled?: boolean;
  },
): Promise<Result<Gate, CoreError>> {
  const existing = await ctx.db.query.gates.findFirst({
    where: and(eq(gates.id, gateId), isNull(gates.archivedAt)),
  });
  if (!existing) return err(coreError('not_found', 'Gate not found'));

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'project.manage_gates', {
      type: 'project',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage gates'));
  }

  let trigger = existing.trigger as GateTrigger;
  if (patch.trigger) {
    const t = GateTriggerSchema.safeParse(patch.trigger);
    if (!t.success) {
      return err(coreError('validation', 'Invalid gate trigger'));
    }
    trigger = t.data;
  }

  let config = existing.config as Record<string, unknown>;
  if (patch.config !== undefined) {
    const c = parseConfig(existing.evaluator, patch.config);
    if (!c.ok) return c;
    config = c.value;
  }

  let appliesWhen = existing.appliesWhen;
  if (patch.appliesWhen !== undefined) {
    const a = validateAppliesWhen(patch.appliesWhen);
    if (!a.ok) return a;
    appliesWhen = a.value as Record<string, unknown> | null;
  }

  const [row] = await ctx.db
    .update(gates)
    .set({
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      trigger,
      appliesWhen,
      config,
      onFailure: patch.onFailure ?? existing.onFailure,
      enabled: patch.enabled ?? existing.enabled,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(gates.id, gateId))
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: existing.projectId,
    type: 'gate.updated',
    subjectType: 'gate',
    subjectId: gateId,
    actor: ctx.actor,
    payload: {
      version: row!.version,
      enabled: row!.enabled,
      previousVersion: existing.version,
    },
  });

  return ok(row!);
}

export async function archiveGate(
  ctx: ServiceContext,
  gateId: string,
): Promise<Result<void, CoreError>> {
  const existing = await ctx.db.query.gates.findFirst({
    where: eq(gates.id, gateId),
  });
  if (!existing || existing.archivedAt) {
    return err(coreError('not_found', 'Gate not found'));
  }
  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'project.manage_gates', {
      type: 'project',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot manage gates'));
  }
  await ctx.db
    .update(gates)
    .set({
      archivedAt: new Date(),
      enabled: false,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(gates.id, gateId));
  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: existing.projectId,
    type: 'gate.archived',
    subjectType: 'gate',
    subjectId: gateId,
    actor: ctx.actor,
    payload: { name: existing.name },
  });
  return ok(undefined);
}

export async function listGates(
  ctx: ServiceContext,
  projectId: string,
): Promise<Result<Gate[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (!can(ctx.actor, 'project.read', { type: 'project', projectId, role })) {
    return err(coreError('not_found', 'Project not found'));
  }
  const rows = await ctx.db.query.gates.findMany({
    where: and(eq(gates.projectId, projectId), isNull(gates.archivedAt)),
    orderBy: [desc(gates.createdAt)],
  });
  return ok(rows);
}

export async function getGate(
  ctx: ServiceContext,
  gateId: string,
): Promise<Result<Gate, CoreError>> {
  const row = await ctx.db.query.gates.findFirst({
    where: and(eq(gates.id, gateId), isNull(gates.archivedAt)),
  });
  if (!row) return err(coreError('not_found', 'Gate not found'));
  const role = await getProjectRole(ctx, row.projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId: row.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Gate not found'));
  }
  return ok(row);
}
