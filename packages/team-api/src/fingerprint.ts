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
  return createHash('sha256').update(stableJson(event)).digest('hex');
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
