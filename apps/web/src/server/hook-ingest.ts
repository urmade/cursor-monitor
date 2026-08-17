import { timingSafeEqual } from 'node:crypto';
import {
  canonicalConversation,
  canonicalRepository,
  normalizeRepositoryLabel,
  UNKNOWN_CONVERSATION_KEY,
} from '@cursor-monitor/core';

export const MAX_HOOK_BYTES = 256 * 1024;

function configuredHookToken(): string | null {
  const value =
    process.env.CURSOR_MONITOR_HOOK_TOKEN?.trim() ||
    process.env.VERCEL_PROTECTION_BYPASS?.trim() ||
    '';
  return value || null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeHookRequest(request: Request): boolean {
  const expected = configuredHookToken();
  if (!expected) return false;
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const supplied =
    request.headers.get('x-cursor-monitor-token')?.trim() || bearer;
  return Boolean(supplied) && safeEqual(supplied, expected);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestamp(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function repositoryFromPayload(payload: Record<string, unknown>): string | null {
  for (const value of [
    payload.repo,
    payload.repository,
    payload.git_repository,
    payload.git_repo,
  ]) {
    const normalized = normalizeRepositoryLabel(stringValue(value));
    if (normalized) return normalized;
  }
  return null;
}

function workspaceFromPayload(payload: Record<string, unknown>): string | null {
  const direct = stringValue(payload.workspace_root);
  if (direct) return direct;
  if (!Array.isArray(payload.workspace_roots)) return null;
  return (
    payload.workspace_roots
      .map(stringValue)
      .find((value): value is string => Boolean(value)) ?? null
  );
}

export type ParsedHookEvent = {
  eventName: string;
  conversationId: string | null;
  conversationKey: string | null;
  generationId: string | null;
  repositoryKey: string | null;
  repositoryLabel: string | null;
  gitBranch: string | null;
  workspaceRoot: string | null;
  userEmail: string | null;
  model: string | null;
  status: string | null;
  durationMs: number | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
};

export function parseHookEvent(
  value: unknown,
  receivedAt = new Date(),
): ParsedHookEvent {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  const conversationId = stringValue(payload.conversation_id);
  const conversationKey = canonicalConversation(conversationId);
  const repositoryLabel = repositoryFromPayload(payload);
  const startedAt = timestamp(payload.started_at);
  const finishedAt = timestamp(payload.finished_at) ?? receivedAt;
  const duration =
    startedAt == null ? null : finishedAt.getTime() - startedAt.getTime();

  return {
    eventName: stringValue(payload.hook_event_name) ?? 'stop',
    conversationId,
    conversationKey:
      conversationKey === UNKNOWN_CONVERSATION_KEY ? null : conversationKey,
    generationId: stringValue(payload.generation_id),
    repositoryKey: repositoryLabel
      ? canonicalRepository(repositoryLabel)
      : null,
    repositoryLabel,
    gitBranch:
      stringValue(payload.git_branch) ??
      stringValue(payload.branch) ??
      stringValue(payload.gitBranch),
    workspaceRoot: workspaceFromPayload(payload),
    userEmail: stringValue(payload.user_email),
    model: stringValue(payload.model) ?? stringValue(payload.model_id),
    status: stringValue(payload.status),
    durationMs:
      duration != null &&
      Number.isFinite(duration) &&
      duration >= 0 &&
      duration <= 2_147_483_647
        ? Math.trunc(duration)
        : null,
    payload,
    occurredAt: finishedAt,
  };
}
