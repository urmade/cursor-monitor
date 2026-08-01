/**
 * Attribute Cloud Agents to Automations via Admin usage events when Org/Team
 * Admin credentials are available. Cloud Agents API responses often omit
 * `automationId` / `source`, so Admin spend events are the reliable join.
 *
 * Prefer Organization Admin (`CURSOR_ORGANIZATION_API_KEY` +
 * `CURSOR_ORGANIZATION_ID` → `/organizations/filtered-usage-events`). Fall back
 * to Team Admin (`CURSOR_ADMIN_API_KEY` / `CURSOR_TEAM_API_KEY` →
 * `/teams/filtered-usage-events`). Phase 0 found the legacy team Admin key
 * returns 401; deploy secrets ship the org pair instead.
 */
import {
  createCursorAdminClient,
  type CursorAdminClient,
  type FilteredUsageEvent,
} from '@nexus/cursor-client';
import type { EnrichedAgent } from './cursor';
import { resolveOrgCostCredentials } from './cursor-org-cost-credentials';

const LOOKBACK_DAYS = 30;
const MAX_EVENT_PAGES = 20;

export type AutomationAttribution = {
  automationId: string;
};

export type AutomationAttributionSource = {
  client: CursorAdminClient;
  /** When set, list uses Organization Admin API. */
  organizationId?: string;
  source: 'org' | 'team';
};

function teamAdminApiKey(): string | null {
  const key =
    process.env.CURSOR_TEAM_API_KEY?.trim() ||
    process.env.CURSOR_ADMIN_API_KEY?.trim() ||
    '';
  return key || null;
}

/** @deprecated Prefer {@link resolveAutomationAttributionSource}. */
export function createEnvAdminClient(): CursorAdminClient | null {
  const apiKey = teamAdminApiKey();
  if (!apiKey) return null;
  return createCursorAdminClient({ apiKey });
}

/**
 * Resolve Admin credentials for automation attribution.
 * Org Admin first (deploy path), then team Admin fallback.
 */
export async function resolveAutomationAttributionSource(opts?: {
  organizationId?: string | null;
  orgApiKey?: string | null;
  baseUrl?: string | null;
}): Promise<AutomationAttributionSource | null> {
  const orgCreds = await resolveOrgCostCredentials({
    organizationId: opts?.organizationId,
    orgApiKey: opts?.orgApiKey,
    baseUrl: opts?.baseUrl,
  });
  if (orgCreds) {
    return {
      client: createCursorAdminClient({
        apiKey: orgCreds.orgApiKey,
        baseUrl: orgCreds.baseUrl,
      }),
      organizationId: orgCreds.organizationId,
      source: 'org',
    };
  }

  const teamKey = teamAdminApiKey();
  if (!teamKey) return null;
  return {
    client: createCursorAdminClient({ apiKey: teamKey }),
    source: 'team',
  };
}

/**
 * Build cloudAgentId → automationId from Admin filtered usage events.
 * Returns an empty map when Admin credentials are missing or the call fails
 * (e.g. key lacks admin/org scope).
 */
export async function loadAutomationAttributionMap(
  adminClientOrSource:
    | CursorAdminClient
    | AutomationAttributionSource
    | null,
  opts?: {
    nowMs?: number;
    lookbackDays?: number;
    listEvents?: (
      client: CursorAdminClient,
      window: {
        startDate: number;
        endDate: number;
        organizationId?: string;
      },
    ) => Promise<{ items: FilteredUsageEvent[]; truncated: boolean }>;
  },
): Promise<Map<string, AutomationAttribution>> {
  const out = new Map<string, AutomationAttribution>();
  if (!adminClientOrSource) return out;

  const source: AutomationAttributionSource =
    'client' in adminClientOrSource && 'source' in adminClientOrSource
      ? adminClientOrSource
      : { client: adminClientOrSource, source: 'team' };

  const nowMs = opts?.nowMs ?? Date.now();
  const lookbackDays = opts?.lookbackDays ?? LOOKBACK_DAYS;
  const window = {
    startDate: nowMs - lookbackDays * 24 * 60 * 60 * 1000,
    endDate: nowMs,
    ...(source.organizationId
      ? { organizationId: source.organizationId }
      : {}),
  };

  try {
    const list =
      opts?.listEvents ??
      ((client, w) =>
        client.listAllFilteredUsageEvents(
          { ...w, automationId: '*' },
          { pageSize: 1000, maxPages: MAX_EVENT_PAGES },
        ));
    const { items } = await list(source.client, window);
    for (const event of items) {
      const agentId = event.cloudAgentId?.trim();
      const automationId = event.automationId?.trim();
      if (!agentId || !automationId) continue;
      if (!out.has(agentId)) {
        out.set(agentId, { automationId });
      }
    }
  } catch {
    // Admin key may lack scope — ignore quietly so Monitoring still loads.
  }
  return out;
}

/**
 * Load attribution using deploy/env Admin credentials (org preferred).
 */
export async function loadAutomationAttributionMapFromEnv(opts?: {
  nowMs?: number;
  lookbackDays?: number;
}): Promise<Map<string, AutomationAttribution>> {
  const source = await resolveAutomationAttributionSource();
  return loadAutomationAttributionMap(source, opts);
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
