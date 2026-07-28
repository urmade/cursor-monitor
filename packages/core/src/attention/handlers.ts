import type { EventType } from '@nexus/contracts';
import { and, eq } from 'drizzle-orm';
import { attentionItems, questions } from '@nexus/db';
import type { ServiceContext } from '../context';
import {
  resolveAttentionBySource,
  resolveAllForWorkItem,
  upsertAttentionFromSource,
} from './projection';
import { listExpectedAttentionSources } from './sources';

const ATTENTION_EVENT_TYPES: Set<EventType> = new Set([
  'question.asked',
  'question.answered',
  'question.withdrawn',
  'gate.blocked',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.withdrawn',
  'budget.blocked',
  'budget.cap_raised',
  'budget.item_overridden',
  'item.resumed',
  'run.failed',
  'run.launch_failed',
  'run.completed_without_report',
  'run.launched',
  'loop.escalated',
  'work_item.stage_changed',
  'work_item.archived',
]);

export function isAttentionEvent(type: string): boolean {
  return ATTENTION_EVENT_TYPES.has(type as EventType);
}

export async function handleAttentionEvent(
  ctx: ServiceContext,
  event: {
    type: string;
    projectId: string | null;
    subjectType: string;
    subjectId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  if (!event.projectId) return;

  switch (event.type) {
    case 'question.asked': {
      let blocking = event.payload.blocking;
      if (blocking !== true) {
        const q = await ctx.db.query.questions.findFirst({
          where: eq(questions.id, event.subjectId),
        });
        blocking = q?.blocking ?? false;
      }
      if (!blocking) return;
      const sources = await listExpectedAttentionSources(ctx, [event.projectId]);
      const match = sources.find(
        (s) => s.sourceType === 'question' && s.sourceId === event.subjectId,
      );
      if (match) await upsertAttentionFromSource(ctx, match);
      break;
    }
    case 'question.answered':
    case 'question.withdrawn':
      await resolveAttentionBySource(ctx, 'question', event.subjectId, event.type);
      break;
    case 'approval.requested': {
      const sources = await listExpectedAttentionSources(ctx, [event.projectId]);
      const match = sources.find(
        (s) => s.sourceType === 'approval' && s.sourceId === event.subjectId,
      );
      if (match) await upsertAttentionFromSource(ctx, match);
      break;
    }
    case 'approval.approved':
    case 'approval.rejected':
    case 'approval.withdrawn':
      await resolveAttentionBySource(ctx, 'approval', event.subjectId, event.type);
      break;
    case 'gate.blocked': {
      const sources = await listExpectedAttentionSources(ctx, [event.projectId]);
      for (const s of sources.filter((x) => x.kind === 'pending_approval')) {
        await upsertAttentionFromSource(ctx, s);
      }
      break;
    }
    case 'budget.blocked': {
      const wid = String(event.payload.workItemId ?? event.subjectId);
      const sources = await listExpectedAttentionSources(ctx, [event.projectId]);
      const match = sources.find(
        (s) => s.kind === 'budget_block' && s.workItemId === wid,
      );
      if (match) await upsertAttentionFromSource(ctx, match);
      break;
    }
    case 'budget.item_overridden': {
      const wid = String(event.payload.workItemId ?? event.subjectId);
      await resolveAttentionBySource(ctx, 'work_item_budget', wid, event.type);
      break;
    }
    case 'budget.cap_raised':
    case 'item.resumed': {
      const wid = String(event.payload.workItemId ?? event.subjectId);
      if (event.type === 'budget.cap_raised') {
        const sources = await listExpectedAttentionSources(ctx, [event.projectId]);
        for (const s of sources.filter((x) => x.kind === 'budget_block')) {
          await resolveAttentionBySource(ctx, 'work_item_budget', s.workItemId, event.type);
        }
      } else {
        await resolveAttentionBySource(ctx, 'work_item_budget', wid, event.type);
      }
      break;
    }
    case 'run.failed':
    case 'run.launch_failed':
    case 'run.completed_without_report': {
      const sources = await listExpectedAttentionSources(ctx, [event.projectId]);
      const match = sources.find(
        (s) => s.sourceType === 'run' && s.sourceId === event.subjectId,
      );
      if (match) await upsertAttentionFromSource(ctx, match);
      break;
    }
    case 'run.launched': {
      const workItemId = String(event.payload.workItemId ?? '');
      const newRunId = event.subjectId;
      if (!workItemId) break;
      const openRuns = await ctx.db.query.attentionItems.findMany({
        where: and(
          eq(attentionItems.workItemId, workItemId),
          eq(attentionItems.status, 'open'),
          eq(attentionItems.sourceType, 'run'),
        ),
      });
      for (const row of openRuns) {
        if (row.sourceId === newRunId) continue;
        await resolveAttentionBySource(ctx, 'run', row.sourceId, 'superseded_by_launch');
      }
      break;
    }
    case 'loop.escalated': {
      const sources = await listExpectedAttentionSources(ctx, [event.projectId]);
      const match = sources.find(
        (s) => s.kind === 'loop_escalation' && s.workItemId === event.subjectId,
      );
      if (match) await upsertAttentionFromSource(ctx, match);
      break;
    }
    case 'work_item.stage_changed':
      if (event.payload.direction === 'forward') {
        await resolveAttentionBySource(
          ctx,
          'work_item_loop',
          event.subjectId,
          'stage_advanced',
        );
      }
      break;
    case 'work_item.archived':
      await resolveAllForWorkItem(ctx, event.subjectId, 'archived');
      break;
    default:
      break;
  }
}
