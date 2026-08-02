/**
 * Cadence sync of Cursor Cloud Agent usage via Admin filtered-usage-events.
 *
 * Primary path: `POST /teams/filtered-usage-events` with `cloudAgentId: "*"`
 * (all Cloud Agent runs — automation-launched and otherwise). Prefer Team API
 * keys attached to a Cursor organisation connection. When an Organisation
 * Admin key + `org_…` id are present, also support
 * `/organizations/filtered-usage-events`.
 *
 * Default window is the last 6 minutes, intended to run every 5 minutes so
 * overlapping polls do not miss late-arriving hourly aggregates.
 *
 * Cost comes from event `chargedCents`. Target repo and duration are enriched
 * from the Cloud Agents API (`GET /v1/agents/{id}` + runs) when a User/Team
 * key on the organisation can see that agent.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  createCursorAdminClient,
  createCursorClient,
  type CursorAdminClient,
  type CursorClient,
  type FilteredUsageEvent,
} from '@nexus/cursor-client';
import {
  appMeta,
  automationAgentRuns,
  automationUsageEvents,
  newId,
  type AutomationUsageSource,
} from '@nexus/db';
import type { ServiceContext } from '../context';
import {
  listCursorOrganisations,
  type DecryptedCursorOrganisation,
} from '../cursor-credentials';

export const AUTOMATION_USAGE_LOOKBACK_MS = 6 * 60 * 1000;
export const AUTOMATION_USAGE_CADENCE_MS = 5 * 60 * 1000;
export const AUTOMATION_USAGE_SYNC_META_KEY = 'automation_usage_sync';
export const DEFAULT_VALIDATION_LABELS = ['FDE', 'ADM'] as const;

const MAX_EVENT_PAGES = 20;
const MAX_ENRICH_AGENTS = 40;

export type AutomationUsageSyncOrgResult = {
  cursorOrganisationId: string;
  label: string;
  organizationId: string | null;
  source: AutomationUsageSource | null;
  ok: boolean;
  skippedReason?: string;
  eventsFetched: number;
  eventsUpserted: number;
  agentsUpserted: number;
  enriched: number;
  enrichmentErrors: number;
  error?: string;
  sample?: {
    automationId: string | null;
    cloudAgentId: string | null;
    targetRepo: string | null;
    chargedCentsTotal: number;
    durationMs: number | null;
  } | null;
};

export type AutomationUsageSyncSummary = {
  at: string;
  lookbackMs: number;
  orgResults: AutomationUsageSyncOrgResult[];
  validation?: {
    labels: string[];
    matched: string[];
    missing: string[];
    ok: boolean;
  };
};

export type AutomationUsageSyncOptions = {
  nowMs?: number;
  lookbackMs?: number;
  /** When set, only organisations whose label matches (case-insensitive whole-token). */
  labelFilter?: string[];
  /** Require these labels to exist with usable keys and a successful fetch. */
  validateLabels?: string[];
  maxEnrichAgents?: number;
  listEvents?: (
    client: CursorAdminClient,
    body: {
      startDate: number;
      endDate: number;
      cloudAgentId?: string;
      automationId?: string;
      organizationId?: string;
    },
  ) => Promise<{ items: FilteredUsageEvent[]; truncated: boolean }>;
  enrichAgent?: (
    client: CursorClient,
    cloudAgentId: string,
  ) => Promise<AgentEnrichment>;
};

export type AgentEnrichment = {
  targetRepo: string | null;
  durationMs: number | null;
  agentName: string | null;
  rawAgent: Record<string, unknown> | null;
  error: string | null;
};

function parseEventTimestamp(raw: string | undefined): Date | null {
  if (!raw) return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) {
    return new Date(asNum < 1e12 ? asNum * 1000 : asNum);
  }
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? new Date(asDate) : null;
}

function labelMatches(label: string, filters: string[]): boolean {
  const tokens = label
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  return filters.some((f) => tokens.includes(f.trim().toUpperCase()));
}

export function eventFingerprint(
  cursorOrganisationId: string,
  event: FilteredUsageEvent,
): string {
  const tokenTotal =
    event.tokenUsage && typeof event.tokenUsage === 'object'
      ? JSON.stringify(event.tokenUsage)
      : '';
  const material = [
    cursorOrganisationId,
    event.timestamp ?? '',
    event.automationId ?? '',
    event.cloudAgentId ?? '',
    event.model ?? '',
    String(event.chargedCents ?? ''),
    String(event.teamId ?? ''),
    event.userEmail ?? '',
    event.serviceAccountId ?? '',
    tokenTotal,
  ].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 40);
}

export function primaryRepoLabel(
  repos: Array<{ url?: string } | string> | null | undefined,
): string | null {
  if (!repos?.length) return null;
  for (const r of repos) {
    const url = typeof r === 'string' ? r : r.url;
    if (!url) continue;
    try {
      const u = new URL(url.includes('://') ? url : `https://${url}`);
      const label =
        u.pathname.replace(/^\//, '').replace(/\.git$/, '') || u.host;
      const normalised = label.trim().toLowerCase();
      if (normalised) return normalised;
    } catch {
      const normalised = url.trim().toLowerCase();
      if (normalised) return normalised;
    }
  }
  return null;
}

export function wallClockDurationMs(
  run: {
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    durationMs?: number | null;
  },
  nowMs: number,
): number | null {
  const terminal = ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'].includes(
    (run.status ?? '').toUpperCase(),
  );
  if (run.createdAt) {
    const start = Date.parse(run.createdAt);
    if (Number.isFinite(start)) {
      let end = nowMs;
      if (run.updatedAt) {
        const u = Date.parse(run.updatedAt);
        if (Number.isFinite(u)) end = u;
      }
      if (!terminal) end = nowMs;
      if (end >= start) return end - start;
    }
  }
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)) {
    return Math.round(run.durationMs);
  }
  return null;
}

export async function defaultEnrichAgent(
  client: CursorClient,
  cloudAgentId: string,
  nowMs: number = Date.now(),
): Promise<AgentEnrichment> {
  try {
    const agent = await client.getAgent(cloudAgentId);
    let durationMs: number | null = null;
    try {
      const runs = await client.listRuns(cloudAgentId, { limit: 5 });
      const items = runs.items ?? [];
      const newest = items[0];
      if (newest) {
        durationMs = wallClockDurationMs(newest, nowMs);
      }
    } catch {
      // Duration is best-effort; repo still useful.
    }
    return {
      targetRepo: primaryRepoLabel(agent.repos),
      durationMs,
      agentName: typeof agent.name === 'string' ? agent.name : null,
      rawAgent: { ...agent },
      error: null,
    };
  } catch (err) {
    return {
      targetRepo: null,
      durationMs: null,
      agentName: null,
      rawAgent: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type UsageSourceClient = {
  source: AutomationUsageSource;
  admin: CursorAdminClient;
  organizationId?: string;
  agents: CursorClient | null;
};

function resolveUsageClients(
  org: DecryptedCursorOrganisation,
): UsageSourceClient | null {
  // Prefer Team API keys for /teams/filtered-usage-events (supports cloudAgentId: "*").
  for (const key of org.apiKeys) {
    return {
      source: 'teams',
      admin: createCursorAdminClient({
        apiKey: key.apiKey,
        baseUrl: org.baseUrl,
        maxRetries: 1,
      }),
      agents: createCursorClient({
        apiKey: key.apiKey,
        baseUrl: org.baseUrl,
        maxRetries: 1,
      }),
    };
  }

  if (org.orgApiKey && org.organizationId?.startsWith('org_')) {
    const agentsKey = org.apiKeys[0]?.apiKey ?? null;
    return {
      source: 'organizations',
      admin: createCursorAdminClient({
        apiKey: org.orgApiKey,
        baseUrl: org.baseUrl,
        maxRetries: 1,
      }),
      organizationId: org.organizationId,
      agents: agentsKey
        ? createCursorClient({
            apiKey: agentsKey,
            baseUrl: org.baseUrl,
            maxRetries: 1,
          })
        : null,
    };
  }

  return null;
}

/**
 * Try Team keys first; if the key lacks usage scope, fall through to the next
 * key, then Organisation Admin. Fetches all Cloud Agent usage via cloudAgentId: "*".
 */
async function fetchCloudAgentEvents(opts: {
  org: DecryptedCursorOrganisation;
  startDate: number;
  endDate: number;
  listEvents: NonNullable<AutomationUsageSyncOptions['listEvents']>;
}): Promise<{
  source: AutomationUsageSource;
  items: FilteredUsageEvent[];
  agentClients: CursorClient[];
}> {
  const errors: string[] = [];
  const agentClients: CursorClient[] = opts.org.apiKeys.map((key) =>
    createCursorClient({
      apiKey: key.apiKey,
      baseUrl: opts.org.baseUrl,
      maxRetries: 1,
    }),
  );

  for (const key of opts.org.apiKeys) {
    const admin = createCursorAdminClient({
      apiKey: key.apiKey,
      baseUrl: opts.org.baseUrl,
      maxRetries: 1,
    });
    try {
      const { items } = await opts.listEvents(admin, {
        startDate: opts.startDate,
        endDate: opts.endDate,
        cloudAgentId: '*',
      });
      return {
        source: 'teams',
        items,
        agentClients,
      };
    } catch (err) {
      errors.push(
        `team:${key.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.org.orgApiKey && opts.org.organizationId?.startsWith('org_')) {
    const admin = createCursorAdminClient({
      apiKey: opts.org.orgApiKey,
      baseUrl: opts.org.baseUrl,
      maxRetries: 1,
    });
    try {
      const { items } = await opts.listEvents(admin, {
        startDate: opts.startDate,
        endDate: opts.endDate,
        cloudAgentId: '*',
        organizationId: opts.org.organizationId,
      });
      return {
        source: 'organizations',
        items,
        agentClients,
      };
    } catch (err) {
      errors.push(
        `org: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.org.apiKeys.length === 0 && !opts.org.orgApiKey) {
    throw new Error('No Team or Organisation API key configured');
  }
  throw new Error(errors.join(' · ') || 'filtered-usage-events failed');
}

function defaultListEvents(
  client: CursorAdminClient,
  body: {
    startDate: number;
    endDate: number;
    cloudAgentId?: string;
    automationId?: string;
    organizationId?: string;
  },
) {
  return client.listAllFilteredUsageEvents(
    {
      startDate: body.startDate,
      endDate: body.endDate,
      ...(body.cloudAgentId ? { cloudAgentId: body.cloudAgentId } : {}),
      ...(body.automationId ? { automationId: body.automationId } : {}),
      ...(body.organizationId ? { organizationId: body.organizationId } : {}),
    },
    { pageSize: 1000, maxPages: MAX_EVENT_PAGES },
  );
}

/** Try each Cloud Agents client until one can see the agent. */
export async function enrichAgentWithAvailableKeys(
  clients: CursorClient[],
  cloudAgentId: string,
  enrich: (
    client: CursorClient,
    id: string,
  ) => Promise<AgentEnrichment>,
): Promise<AgentEnrichment> {
  if (clients.length === 0) {
    return {
      targetRepo: null,
      durationMs: null,
      agentName: null,
      rawAgent: null,
      error: 'No Cloud Agents API key on this organisation',
    };
  }
  const errors: string[] = [];
  for (const client of clients) {
    const result = await enrich(client, cloudAgentId);
    if (!result.error) return result;
    errors.push(result.error);
  }
  return {
    targetRepo: null,
    durationMs: null,
    agentName: null,
    rawAgent: null,
    error: errors[errors.length - 1] ?? 'Enrichment failed for all keys',
  };
}

export async function syncAutomationUsageForOrganisation(
  ctx: ServiceContext,
  org: DecryptedCursorOrganisation,
  opts: AutomationUsageSyncOptions = {},
): Promise<AutomationUsageSyncOrgResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const lookbackMs = opts.lookbackMs ?? AUTOMATION_USAGE_LOOKBACK_MS;
  const startDate = nowMs - lookbackMs;
  const endDate = nowMs;
  const listEvents = opts.listEvents ?? defaultListEvents;
  const enrich =
    opts.enrichAgent ??
    ((client, id) => defaultEnrichAgent(client, id, nowMs));
  const maxEnrich = opts.maxEnrichAgents ?? MAX_ENRICH_AGENTS;

  const base: AutomationUsageSyncOrgResult = {
    cursorOrganisationId: org.id,
    label: org.label,
    organizationId: org.organizationId,
    source: null,
    ok: false,
    eventsFetched: 0,
    eventsUpserted: 0,
    agentsUpserted: 0,
    enriched: 0,
    enrichmentErrors: 0,
    sample: null,
  };

  if (org.apiKeys.length === 0 && !org.orgApiKey) {
    return {
      ...base,
      skippedReason: 'no_api_keys',
      error: 'Organisation has no Team or Organisation API key',
    };
  }

  let items: FilteredUsageEvent[];
  let source: AutomationUsageSource;
  let agentClients: CursorClient[];
  try {
    const fetched = await fetchCloudAgentEvents({
      org,
      startDate,
      endDate,
      listEvents,
    });
    items = fetched.items;
    source = fetched.source;
    agentClients = fetched.agentClients;
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  base.source = source;
  base.eventsFetched = items.length;
  base.ok = true;

  type AgentBucket = {
    automationId: string | null;
    cloudAgentId: string;
    chargedCentsTotal: number;
    eventCount: number;
    firstEventAt: Date | null;
    lastEventAt: Date | null;
    latestModel: string | null;
  };
  const byAgent = new Map<string, AgentBucket>();
  const now = new Date(nowMs);

  for (const event of items) {
    const cloudAgentId = event.cloudAgentId?.trim() || null;
    // Ledger is Cloud-Agent-centric; skip non-agent spend rows.
    if (!cloudAgentId || cloudAgentId === '*') continue;
    const ts = parseEventTimestamp(event.timestamp);
    if (!ts) continue;

    const automationRaw = event.automationId?.trim() || null;
    const automationId =
      automationRaw && automationRaw !== '*' ? automationRaw : null;
    const fingerprint = eventFingerprint(org.id, event);
    const charged =
      typeof event.chargedCents === 'number' && Number.isFinite(event.chargedCents)
        ? event.chargedCents
        : null;

    await ctx.db
      .insert(automationUsageEvents)
      .values({
        id: newId(),
        orgId: ctx.orgId,
        cursorOrganisationId: org.id,
        eventFingerprint: fingerprint,
        source,
        eventTimestamp: ts,
        automationId,
        cloudAgentId,
        teamId: typeof event.teamId === 'number' ? event.teamId : null,
        model: event.model ?? null,
        kind: event.kind ?? null,
        chargedCents: charged,
        userEmail: event.userEmail ?? null,
        serviceAccountId: event.serviceAccountId ?? null,
        serviceAccountName: event.serviceAccountName ?? null,
        targetRepo: null,
        durationMs: null,
        rawEvent: { ...event },
        fetchedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          automationUsageEvents.cursorOrganisationId,
          automationUsageEvents.eventFingerprint,
        ],
        set: {
          chargedCents: charged,
          automationId,
          model: event.model ?? null,
          kind: event.kind ?? null,
          rawEvent: { ...event },
          updatedAt: now,
          fetchedAt: now,
        },
      });
    base.eventsUpserted += 1;

    const bucket = byAgent.get(cloudAgentId) ?? {
      automationId,
      cloudAgentId,
      chargedCentsTotal: 0,
      eventCount: 0,
      firstEventAt: null,
      lastEventAt: null,
      latestModel: null,
    };
    bucket.eventCount += 1;
    if (charged != null) bucket.chargedCentsTotal += charged;
    if (!bucket.firstEventAt || ts < bucket.firstEventAt) bucket.firstEventAt = ts;
    if (!bucket.lastEventAt || ts > bucket.lastEventAt) {
      bucket.lastEventAt = ts;
      bucket.latestModel = event.model ?? bucket.latestModel;
      if (automationId) bucket.automationId = automationId;
    }
    byAgent.set(cloudAgentId, bucket);
  }

  const enrichmentCache = new Map<string, AgentEnrichment>();
  let enrichCount = 0;
  for (const bucket of byAgent.values()) {
    // Absolute totals from stored events — overlapping cadence windows must
    // not double-count cost/event_count.
    const totals = await ctx.db
      .select({
        chargedCentsTotal: sql<number>`coalesce(sum(${automationUsageEvents.chargedCents}), 0)`,
        eventCount: sql<number>`count(*)::int`,
        firstEventAt: sql<Date | null>`min(${automationUsageEvents.eventTimestamp})`,
        lastEventAt: sql<Date | null>`max(${automationUsageEvents.eventTimestamp})`,
      })
      .from(automationUsageEvents)
      .where(
        and(
          eq(automationUsageEvents.orgId, ctx.orgId),
          eq(automationUsageEvents.cursorOrganisationId, org.id),
          eq(automationUsageEvents.cloudAgentId, bucket.cloudAgentId),
        ),
      );
    const agg = totals[0];
    const chargedCentsTotal = Number(agg?.chargedCentsTotal ?? bucket.chargedCentsTotal);
    const eventCount = Number(agg?.eventCount ?? bucket.eventCount);
    const firstEventAt = agg?.firstEventAt ?? bucket.firstEventAt;
    const lastEventAt = agg?.lastEventAt ?? bucket.lastEventAt;

    let enrichment: AgentEnrichment = {
      targetRepo: null,
      durationMs: null,
      agentName: null,
      rawAgent: null,
      error:
        agentClients.length === 0
          ? 'No Cloud Agents API key on this organisation'
          : null,
    };

    if (agentClients.length > 0 && enrichCount < maxEnrich) {
      const cached = enrichmentCache.get(bucket.cloudAgentId);
      if (cached) {
        enrichment = cached;
      } else {
        enrichment = await enrichAgentWithAvailableKeys(
          agentClients,
          bucket.cloudAgentId,
          enrich,
        );
        enrichmentCache.set(bucket.cloudAgentId, enrichment);
        enrichCount += 1;
        if (enrichment.error) base.enrichmentErrors += 1;
        else if (enrichment.targetRepo || enrichment.durationMs != null) {
          base.enriched += 1;
        }
      }
    } else if (agentClients.length === 0) {
      base.enrichmentErrors += 1;
    }

    const existing = await ctx.db.query.automationAgentRuns.findFirst({
      where: and(
        eq(automationAgentRuns.cursorOrganisationId, org.id),
        eq(automationAgentRuns.cloudAgentId, bucket.cloudAgentId),
      ),
    });

    const targetRepo = enrichment.targetRepo ?? existing?.targetRepo ?? null;
    const durationMs = enrichment.durationMs ?? existing?.durationMs ?? null;
    const agentName = enrichment.agentName ?? existing?.agentName ?? null;
    const rawAgent = enrichment.rawAgent ?? existing?.rawAgent ?? null;
    const automationId =
      bucket.automationId ?? existing?.automationId ?? null;

    await ctx.db
      .insert(automationAgentRuns)
      .values({
        id: existing?.id ?? newId(),
        orgId: ctx.orgId,
        cursorOrganisationId: org.id,
        automationId,
        cloudAgentId: bucket.cloudAgentId,
        targetRepo,
        durationMs,
        chargedCentsTotal,
        eventCount,
        firstEventAt,
        lastEventAt,
        agentName,
        latestModel: bucket.latestModel ?? existing?.latestModel ?? null,
        source,
        enrichmentError: enrichment.error,
        rawAgent,
        fetchedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          automationAgentRuns.cursorOrganisationId,
          automationAgentRuns.cloudAgentId,
        ],
        set: {
          automationId,
          targetRepo,
          durationMs,
          chargedCentsTotal,
          eventCount,
          firstEventAt,
          lastEventAt,
          agentName,
          latestModel: bucket.latestModel ?? existing?.latestModel ?? null,
          source,
          enrichmentError: enrichment.error,
          rawAgent,
          fetchedAt: now,
          updatedAt: now,
        },
      });
    base.agentsUpserted += 1;

    if (targetRepo || durationMs != null) {
      await ctx.db
        .update(automationUsageEvents)
        .set({
          targetRepo,
          durationMs,
          updatedAt: now,
        })
        .where(
          and(
            eq(automationUsageEvents.cursorOrganisationId, org.id),
            eq(automationUsageEvents.cloudAgentId, bucket.cloudAgentId),
            eq(automationUsageEvents.orgId, ctx.orgId),
          ),
        );
    }

    if (!base.sample) {
      base.sample = {
        automationId: bucket.automationId,
        cloudAgentId: bucket.cloudAgentId,
        targetRepo,
        chargedCentsTotal,
        durationMs,
      };
    }
  }

  return base;
}

export async function syncAutomationUsageEvents(
  ctx: ServiceContext,
  opts: AutomationUsageSyncOptions = {},
): Promise<AutomationUsageSyncSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const lookbackMs = opts.lookbackMs ?? AUTOMATION_USAGE_LOOKBACK_MS;
  const orgs = await listCursorOrganisations(ctx);
  const filtered = opts.labelFilter?.length
    ? orgs.filter((o) => labelMatches(o.label, opts.labelFilter!))
    : orgs;

  const orgResults: AutomationUsageSyncOrgResult[] = [];
  for (const org of filtered) {
    orgResults.push(await syncAutomationUsageForOrganisation(ctx, org, opts));
  }

  let validation: AutomationUsageSyncSummary['validation'];
  if (opts.validateLabels?.length) {
    const labels = opts.validateLabels.map((l) => l.trim().toUpperCase());
    const matched: string[] = [];
    const missing: string[] = [];
    for (const label of labels) {
      const hits = orgResults.filter(
        (r) => labelMatches(r.label, [label]) && r.ok,
      );
      if (hits.length > 0) matched.push(label);
      else missing.push(label);
    }
    validation = {
      labels,
      matched,
      missing,
      ok: missing.length === 0,
    };
  }

  const summary: AutomationUsageSyncSummary = {
    at: new Date(nowMs).toISOString(),
    lookbackMs,
    orgResults,
    validation,
  };

  await ctx.db
    .insert(appMeta)
    .values({
      key: AUTOMATION_USAGE_SYNC_META_KEY,
      value: summary as unknown as Record<string, unknown>,
      updatedAt: new Date(nowMs),
    })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: {
        value: summary as unknown as Record<string, unknown>,
        updatedAt: new Date(nowMs),
      },
    });

  return summary;
}

export async function readLastAutomationUsageSync(): Promise<AutomationUsageSyncSummary | null> {
  try {
    const { getDb } = await import('@nexus/db');
    const db = getDb();
    const row = await db.query.appMeta.findFirst({
      where: eq(appMeta.key, AUTOMATION_USAGE_SYNC_META_KEY),
    });
    if (!row?.value || typeof row.value !== 'object') return null;
    return row.value as unknown as AutomationUsageSyncSummary;
  } catch {
    return null;
  }
}

/** Sync only FDE / ADM organisations and require both to succeed. */
export async function validateFdeAdmAutomationUsageSync(
  ctx: ServiceContext,
  opts: Omit<AutomationUsageSyncOptions, 'labelFilter' | 'validateLabels'> = {},
): Promise<AutomationUsageSyncSummary> {
  return syncAutomationUsageEvents(ctx, {
    ...opts,
    labelFilter: [...DEFAULT_VALIDATION_LABELS],
    validateLabels: [...DEFAULT_VALIDATION_LABELS],
    // Wider window for a one-shot validation so empty 6-minute windows still
    // prove the key + endpoint path (cost/repo/duration when events exist).
    lookbackMs: opts.lookbackMs ?? 60 * 60 * 1000,
  });
}

export type SyncedCloudAgentRun = {
  id: string;
  cursorOrganisationId: string;
  organisationLabel: string | null;
  automationId: string | null;
  cloudAgentId: string;
  targetRepo: string | null;
  durationMs: number | null;
  chargedCentsTotal: number;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  agentName: string | null;
  latestModel: string | null;
  source: AutomationUsageSource;
  enrichmentError: string | null;
  enriched: boolean;
};

/**
 * Recent Cloud Agent / automation runs persisted by the cadence sync job.
 * Used by Monitoring's separate "synced" section — does not replace the
 * live user-key catalogue.
 */
export async function listSyncedCloudAgentRuns(
  ctx: ServiceContext,
  opts?: { limit?: number },
): Promise<SyncedCloudAgentRun[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 200);
  const orgs = await listCursorOrganisations(ctx);
  const labelById = new Map(orgs.map((o) => [o.id, o.label]));

  const rows = await ctx.db.query.automationAgentRuns.findMany({
    where: eq(automationAgentRuns.orgId, ctx.orgId),
    orderBy: (t, { desc }) => [desc(t.lastEventAt), desc(t.updatedAt)],
    limit,
  });

  return rows.map((row) => ({
    id: row.id,
    cursorOrganisationId: row.cursorOrganisationId,
    organisationLabel: labelById.get(row.cursorOrganisationId) ?? null,
    automationId: row.automationId,
    cloudAgentId: row.cloudAgentId,
    targetRepo: row.targetRepo,
    durationMs: row.durationMs,
    chargedCentsTotal: Number(row.chargedCentsTotal ?? 0),
    eventCount: row.eventCount,
    firstEventAt: row.firstEventAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    agentName: row.agentName,
    latestModel: row.latestModel,
    source: row.source,
    enrichmentError: row.enrichmentError,
    enriched: Boolean(row.targetRepo || row.durationMs != null || row.agentName),
  }));
}

/**
 * Opportunistically enrich synced rows with any Cloud Agents clients that can
 * see the agent (typically the user's attached User/Team keys). Persists
 * successful enrichment back to the ledger.
 */
export async function enrichSyncedCloudAgentRuns(
  ctx: ServiceContext,
  runs: SyncedCloudAgentRun[],
  clients: CursorClient[],
  opts?: {
    maxEnrich?: number;
    enrichAgent?: (
      client: CursorClient,
      cloudAgentId: string,
    ) => Promise<AgentEnrichment>;
    nowMs?: number;
  },
): Promise<SyncedCloudAgentRun[]> {
  if (runs.length === 0 || clients.length === 0) return runs;
  const nowMs = opts?.nowMs ?? Date.now();
  const enrich =
    opts?.enrichAgent ??
    ((client, id) => defaultEnrichAgent(client, id, nowMs));
  const maxEnrich = opts?.maxEnrich ?? 20;
  let enrichedCount = 0;
  const out: SyncedCloudAgentRun[] = [];

  for (const run of runs) {
    if (run.enriched || enrichedCount >= maxEnrich) {
      out.push(run);
      continue;
    }
    const enrichment = await enrichAgentWithAvailableKeys(
      clients,
      run.cloudAgentId,
      enrich,
    );
    enrichedCount += 1;
    if (enrichment.error || (!enrichment.targetRepo && enrichment.durationMs == null && !enrichment.agentName)) {
      out.push({
        ...run,
        enrichmentError: enrichment.error ?? run.enrichmentError,
      });
      continue;
    }

    const now = new Date(nowMs);
    await ctx.db
      .update(automationAgentRuns)
      .set({
        targetRepo: enrichment.targetRepo ?? run.targetRepo,
        durationMs: enrichment.durationMs ?? run.durationMs,
        agentName: enrichment.agentName ?? run.agentName,
        rawAgent: enrichment.rawAgent,
        enrichmentError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(automationAgentRuns.id, run.id),
          eq(automationAgentRuns.orgId, ctx.orgId),
        ),
      );

    out.push({
      ...run,
      targetRepo: enrichment.targetRepo ?? run.targetRepo,
      durationMs: enrichment.durationMs ?? run.durationMs,
      agentName: enrichment.agentName ?? run.agentName,
      enrichmentError: null,
      enriched: true,
    });
  }

  return out;
}

// Keep resolveUsageClients referenced for tests / debugging helpers.
export const __testing = { resolveUsageClients, labelMatches, parseEventTimestamp };
