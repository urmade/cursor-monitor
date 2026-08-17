import { createHash } from 'node:crypto';
import type { UsageEvent } from './types';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/** Stable idempotency key for overlapping Team API polling windows. */
export function usageEventFingerprint(event: UsageEvent): string {
  const record = event as Record<string, unknown>;
  const upstreamId = [
    record['id'],
    record['usageEventId'],
    record['usage_event_id'],
    record['usageUuid'],
    record['requestId'],
  ].find((value): value is string => typeof value === 'string' && value.length > 0);
  const identity = upstreamId
    ? { version: 2, upstreamId }
    : {
        version: 2,
        timestamp: event.timestamp,
        conversationKey: usageConversationKey(event),
        userEmail: event.userEmail?.trim().toLowerCase() ?? null,
        serviceAccountId: event.serviceAccountId ?? null,
        cloudAgentId: event.cloudAgentId ?? null,
        automationId: event.automationId ?? null,
        model: event.model ?? null,
        kind: event.kind ?? null,
        chargedCents: event.chargedCents ?? null,
        requestsCosts: record['requestsCosts'] ?? null,
        tokenUsage: record['tokenUsage'] ?? null,
      };
  return createHash('sha256').update(stableJson(identity)).digest('hex');
}

export function usageConversationKey(event: UsageEvent): string | null {
  const raw =
    event.conversationId ??
    (event as Record<string, unknown>)['conversation_id'] ??
    (event as Record<string, unknown>)['conversationID'];
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value || null;
}
