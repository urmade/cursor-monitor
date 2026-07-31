/**
 * Attribute Cloud Agents to Automations via Admin usage events when a
 * team Admin API key is available. Cloud Agents API responses often omit
 * `automationId` / `source`, so Admin spend events are the reliable join.
 */
import {
  createCursorAdminClient,
  type CursorAdminClient,
  type FilteredUsageEvent,
} from '@nexus/cursor-client';
import type { EnrichedAgent } from './cursor';

const LOOKBACK_DAYS = 30;
const MAX_EVENT_PAGES = 20;

export type AutomationAttribution = {
  automationId: string;
};

function envAdminApiKey(): string | null {
  const key = process.env.CURSOR_ADMIN_API_KEY?.trim() ?? '';
  return key || null;
}

export function createEnvAdminClient(): CursorAdminClient | null {
  const apiKey = envAdminApiKey();
  if (!apiKey) return null;
  return createCursorAdminClient({ apiKey });
}

/**
 * Build cloudAgentId → automationId from Admin filtered usage events.
 * Returns an empty map when the Admin client is missing or the call fails
 * (e.g. key lacks admin:* scope).
 */
export async function loadAutomationAttributionMap(
  adminClient: CursorAdminClient | null,
  opts?: {
    nowMs?: number;
    lookbackDays?: number;
    listEvents?: (
      client: CursorAdminClient,
      window: { startDate: number; endDate: number },
    ) => Promise<{ items: FilteredUsageEvent[]; truncated: boolean }>;
  },
): Promise<Map<string, AutomationAttribution>> {
  const out = new Map<string, AutomationAttribution>();
  if (!adminClient) return out;

  const nowMs = opts?.nowMs ?? Date.now();
  const lookbackDays = opts?.lookbackDays ?? LOOKBACK_DAYS;
  const window = {
    startDate: nowMs - lookbackDays * 24 * 60 * 60 * 1000,
    endDate: nowMs,
  };

  try {
    const list =
      opts?.listEvents ??
      ((client, w) =>
        client.listAllFilteredUsageEvents(
          { ...w, automationId: '*' },
          { pageSize: 1000, maxPages: MAX_EVENT_PAGES },
        ));
    const { items } = await list(adminClient, window);
    for (const event of items) {
      const agentId = event.cloudAgentId?.trim();
      const automationId = event.automationId?.trim();
      if (!agentId || !automationId) continue;
      if (!out.has(agentId)) {
        out.set(agentId, { automationId });
      }
    }
  } catch {
    // Admin key may be a personal key without admin:* — ignore quietly.
  }
  return out;
}

/** Stamp automationId onto enriched agents when attribution is known. */
export function applyAutomationAttribution(
  agents: EnrichedAgent[],
  attribution: Map<string, AutomationAttribution>,
): EnrichedAgent[] {
  if (attribution.size === 0) return agents;
  return agents.map((agent) => {
    if (agent.automationId) return agent;
    const hit = attribution.get(agent.id);
    if (!hit) return agent;
    return {
      ...agent,
      automationId: hit.automationId,
      source: agent.source ?? 'automations',
    };
  });
}
