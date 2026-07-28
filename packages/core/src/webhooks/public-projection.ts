import type { PublicEventType } from '@nexus/contracts';
import { PUBLIC_EVENTS } from '@nexus/contracts';

type EventRow = {
  type: string;
  publicType: string;
  subjectId: string;
  payload: unknown;
};

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function snakeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    out[snake] = v;
  }
  return out;
}

/** Map internal outbox payloads to frozen public catalogue `data` shapes. */
export function projectPublicEventData(
  row: EventRow,
  hints: { workItemKey?: string },
): Record<string, unknown> {
  const p = asRecord(row.payload);
  const publicType = row.publicType as PublicEventType;

  switch (publicType) {
    case 'work_item.created':
      return {
        key: hints.workItemKey ?? String(p.key ?? ''),
        title: String(p.title ?? ''),
        complexity: (p.complexity as string | null | undefined) ?? null,
      };
    case 'work_item.updated': {
      const out: Record<string, unknown> = {
        key: hints.workItemKey ?? String(p.key ?? ''),
      };
      if (p.title !== undefined) out.title = String(p.title);
      if (p.complexity !== undefined) out.complexity = p.complexity;
      if (p.labels !== undefined) out.labels = p.labels;
      return out;
    }
    case 'work_item.status_changed':
      return {
        key: hints.workItemKey ?? String(p.key ?? ''),
        from: (p.from as string | null | undefined) ?? null,
        to: String(p.to ?? ''),
      };
    case 'work_item.stage_changed':
      return snakeKeys({
        from: p.from ?? null,
        to: p.to,
        direction: p.direction,
        reasonCode: p.reasonCode ?? p.reason_code ?? null,
      });
    case 'spec.version_created':
      return {
        version: Number(p.version ?? 0),
        content_hash: (p.contentHash as string | undefined) ?? (p.content_hash as string | undefined),
      };
    case 'run.started':
      return snakeKeys({
        runId: p.runId ?? p.run_id ?? row.subjectId,
        stageKey: p.stageKey ?? p.stage_key,
      });
    case 'run.finished':
      return snakeKeys({
        runId: p.runId ?? p.run_id ?? row.subjectId,
        outcome: String(p.outcome ?? ''),
        stageKey: p.stageKey ?? p.stage_key,
      });
    case 'stage_report.posted':
      return snakeKeys({
        runId: p.runId ?? p.run_id,
        stageKey: p.stageKey ?? p.stage_key,
        reportId: p.reportId ?? p.report_id ?? row.subjectId,
      });
    case 'question.asked':
      return {
        question_id: row.subjectId,
        text: String(p.text ?? ''),
        blocking: Boolean(p.blocking),
      };
    case 'question.answered':
      return {
        question_id: row.subjectId,
        answer: p.answer !== undefined ? String(p.answer) : undefined,
      };
    case 'gate.evaluated':
      return snakeKeys({
        gateId: p.gateId ?? p.gate_id,
        gateKey: p.gateKey ?? p.gate_key,
        outcome: String(p.outcome ?? ''),
        batchId: p.batchId ?? p.batch_id,
      });
    case 'approval.decided': {
      const decision =
        row.type === 'approval.rejected'
          ? 'rejected'
          : row.type === 'approval.approved'
            ? 'approved'
            : (p.decision as string | undefined) === 'rejected'
              ? 'rejected'
              : 'approved';
      return snakeKeys({
        approvalId: row.subjectId,
        decision,
        gateId: p.gateId ?? p.gate_id,
      });
    }
    case 'budget.threshold_crossed':
      return snakeKeys({
        scope: p.scope,
        threshold: p.threshold,
        ratio: p.ratio,
      });
    case 'budget.blocked':
      return snakeKeys({
        workItemId: p.workItemId ?? p.work_item_id,
        reason: p.reason,
      });
    case 'loop.detected':
    case 'loop.escalated':
      return snakeKeys({
        loopEdgeId: p.loopEdgeId ?? p.loop_edge_id,
        reasonCode: p.reasonCode ?? p.reason_code,
      });
    default:
      return snakeKeys(p);
  }
}

export function parsePublicEventData(
  publicType: PublicEventType,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const entry = PUBLIC_EVENTS[publicType];
  return entry.schema.parse(data) as Record<string, unknown>;
}
