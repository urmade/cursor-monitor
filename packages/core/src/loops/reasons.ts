import { and, asc, eq, isNull, type InferSelectModel } from 'drizzle-orm';
import { DEFAULT_LOOP_REASON_CODES } from '@nexus/contracts';
import { loopReasonCodes, newId, type Db } from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import type { Tx } from '../events/emit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';

export type LoopReasonCode = InferSelectModel<typeof loopReasonCodes>;

export async function seedDefaultReasonCodes(
  db: Db | Tx | ServiceContext,
  projectId: string,
): Promise<void> {
  const client: Db | Tx =
    'actor' in db && 'db' in db ? (db as ServiceContext).db : (db as Db | Tx);
  for (const row of DEFAULT_LOOP_REASON_CODES) {
    await client
      .insert(loopReasonCodes)
      .values({
        id: newId(),
        projectId,
        code: row.code,
        label: row.label,
        requiresNote: row.requiresNote,
        position: row.position,
      })
      .onConflictDoNothing();
  }
}

export async function listReasonCodes(
  ctx: ServiceContext,
  projectId: string,
  opts?: { includeArchived?: boolean },
): Promise<Result<LoopReasonCode[], CoreError>> {
  const role = await getProjectRole(ctx, projectId);
  if (
    !can(ctx.actor, 'project.read', {
      type: 'project',
      projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot read project'));
  }

  const rows = await ctx.db.query.loopReasonCodes.findMany({
    where: opts?.includeArchived
      ? eq(loopReasonCodes.projectId, projectId)
      : and(
          eq(loopReasonCodes.projectId, projectId),
          isNull(loopReasonCodes.archivedAt),
        ),
    orderBy: [asc(loopReasonCodes.position)],
  });
  return ok(rows);
}

export async function upsertReasonCode(
  ctx: ServiceContext,
  input: {
    projectId: string;
    code: string;
    label: string;
    requiresNote?: boolean;
    position?: number;
  },
): Promise<Result<LoopReasonCode, CoreError>> {
  const role = await getProjectRole(ctx, input.projectId);
  if (
    !can(ctx.actor, 'project.update', {
      type: 'project',
      projectId: input.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot update project settings'));
  }

  const code = input.code.trim().toLowerCase().replace(/\s+/g, '_');
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
    return err(
      coreError(
        'validation',
        'Reason code must be snake_case starting with a letter',
      ),
    );
  }
  const label = input.label.trim();
  if (!label) return err(coreError('validation', 'Label is required'));

  const existing = await ctx.db.query.loopReasonCodes.findFirst({
    where: and(
      eq(loopReasonCodes.projectId, input.projectId),
      eq(loopReasonCodes.code, code),
    ),
  });

  if (existing) {
    const [row] = await ctx.db
      .update(loopReasonCodes)
      .set({
        label,
        requiresNote: input.requiresNote ?? existing.requiresNote,
        position: input.position ?? existing.position,
        archivedAt: null,
      })
      .where(eq(loopReasonCodes.id, existing.id))
      .returning();
    return ok(row!);
  }

  const [row] = await ctx.db
    .insert(loopReasonCodes)
    .values({
      id: newId(),
      projectId: input.projectId,
      code,
      label,
      requiresNote: input.requiresNote ?? false,
      position: input.position ?? 100,
    })
    .returning();
  return ok(row!);
}

export async function archiveReasonCode(
  ctx: ServiceContext,
  id: string,
): Promise<Result<LoopReasonCode, CoreError>> {
  const existing = await ctx.db.query.loopReasonCodes.findFirst({
    where: eq(loopReasonCodes.id, id),
  });
  if (!existing) return err(coreError('not_found', 'Reason code not found'));

  const role = await getProjectRole(ctx, existing.projectId);
  if (
    !can(ctx.actor, 'project.update', {
      type: 'project',
      projectId: existing.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot update project settings'));
  }

  const [row] = await ctx.db
    .update(loopReasonCodes)
    .set({ archivedAt: new Date() })
    .where(eq(loopReasonCodes.id, id))
    .returning();
  return ok(row!);
}

/**
 * Validate a reason code for a manual return. Auto codes (gate_block, unknown)
 * may bypass taxonomy membership when the trigger is non-human.
 */
export async function resolveReturnReason(
  ctx: ServiceContext,
  projectId: string,
  input: {
    reasonCode: string | undefined;
    note: string | undefined;
    triggerKind: 'human' | 'gate' | 'report' | 'system' | 'backfill';
  },
): Promise<Result<{ reasonCode: string; note: string | null }, CoreError>> {
  const code = input.reasonCode?.trim();

  if (input.triggerKind === 'gate') {
    return ok({
      reasonCode: code && code.length > 0 ? code : 'gate_block',
      note: input.note?.trim() || null,
    });
  }
  if (input.triggerKind === 'report') {
    return ok({
      reasonCode: code && code.length > 0 ? code : 'failed_verification',
      note: input.note?.trim() || null,
    });
  }
  if (input.triggerKind === 'backfill' || input.triggerKind === 'system') {
    return ok({
      reasonCode: code && code.length > 0 ? code : 'unknown',
      note: input.note?.trim() || null,
    });
  }

  if (!code) {
    return err(
      coreError('validation', 'Reason code is required on a return edge'),
    );
  }

  const taxonomy = await ctx.db.query.loopReasonCodes.findFirst({
    where: and(
      eq(loopReasonCodes.projectId, projectId),
      eq(loopReasonCodes.code, code),
      isNull(loopReasonCodes.archivedAt),
    ),
  });
  if (!taxonomy) {
    return err(coreError('validation', `Unknown reason code: ${code}`));
  }

  const note = input.note?.trim() || null;
  if (taxonomy.requiresNote && !note) {
    return err(
      coreError('validation', `Reason code "${code}" requires a note`),
    );
  }

  return ok({ reasonCode: code, note });
}
