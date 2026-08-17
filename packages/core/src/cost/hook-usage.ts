import {
  createCursorAdminClient,
  type CursorAdminClient,
  type FilteredUsageEvent,
} from '@nexus/cursor-client';
import { and, asc, eq, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { cursorStopHookEvents, getDb, type Db } from '@nexus/db';
import { createContext, silentLogger, type ServiceContext } from '../context';
import { createFlagReader } from '../flags';
import {
  listCursorOrganisations,
  type DecryptedCursorApiKey,
  type DecryptedCursorOrganisation,
} from '../cursor-credentials';
import { normalizeCursorBaseUrl } from '../cursor-credentials/base-url';

export const HOOK_COST_DELAY_MS = 5 * 60 * 1000;
export const HOOK_COST_CADENCE_MS = 5 * 60 * 1000;
export const HOOK_COST_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const HOOK_COST_PENDING_SOURCE = 'pending';
export const HOOK_COST_TEAM_SOURCE = 'teams.filtered-usage-events';
export const HOOK_COST_BACKFILL_LIMIT = 5000;
export const HOOK_COST_BACKFILL_PAGE_SIZE = 1000;
export const HOOK_COST_BACKFILL_MAX_PAGES = 50;

export type HookUsageCostLookup = {
  chargedCents: number | null;
  costSource: string | null;
  usageEvent: Record<string, unknown> | null;
  costLookupError: string | null;
};

export type TeamCostCredential = {
  apiKey: string;
  baseUrl: string;
  source: 'db' | 'env';
  label: string;
};

export type PendingHookCostRow = {
  id: string;
  userEmail: string | null;
  model: string | null;
  conversationId?: string | null;
  receivedAt: Date;
  finishedAt: Date | null;
  startedAt?: Date | null;
};

export type HookCostReconcileSummary = {
  pending: number;
  upgraded: number;
  waiting: number;
  expired: number;
  failed: number;
  skippedYoung: number;
  credentials: number;
  message?: string;
};

export type HookCostBackfillSummary = {
  fromReceivedAt: string | null;
  pending: number;
  upgraded: number;
  unmatched: number;
  failed: number;
  usageEvents: number;
  usageTruncated: boolean;
  pendingTruncated: boolean;
  credentials: number;
  skippedNoHooks: boolean;
  skippedNoTeamKey: boolean;
  message?: string;
};

export type FetchTeamUsageEvents = (opts: {
  client: CursorAdminClient;
  email: string | null;
  startDate: number;
  endDate: number;
}) => Promise<FilteredUsageEvent[]>;

const DEFAULT_LOOKBACK_MS = 20 * 60 * 1000;

function teamApiKeyFromEnv(): string | null {
  const value =
    process.env.CURSOR_TEAM_API_KEY?.trim() ||
    process.env.CURSOR_ADMIN_API_KEY?.trim() ||
    '';
  return value || null;
}

export function parseEventTimestampMs(raw: string | undefined): number {
  if (!raw) return 0;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum < 1e12 ? asNum * 1000 : asNum;
  }
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : 0;
}

export function normalizeConversationId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function usageEventConversationId(
  event: FilteredUsageEvent,
): string | null {
  const rec = event as Record<string, unknown>;
  return (
    normalizeConversationId(event.conversationId) ??
    normalizeConversationId(rec.conversation_id) ??
    normalizeConversationId(rec.conversationID)
  );
}

export function usageEventFingerprint(event: FilteredUsageEvent): string {
  return [
    event.timestamp ?? '',
    event.userEmail ?? '',
    event.model ?? '',
    String(event.chargedCents ?? ''),
    event.cloudAgentId ?? '',
    String(event.teamId ?? ''),
    usageEventConversationId(event) ?? '',
  ].join('|');
}

function hookAnchorMs(row: PendingHookCostRow): number {
  return (row.finishedAt ?? row.receivedAt).getTime();
}

export function sumChargedCents(events: FilteredUsageEvent[]): number | null {
  let sum = 0;
  let any = false;
  for (const event of events) {
    if (typeof event.chargedCents === 'number' && Number.isFinite(event.chargedCents)) {
      sum += event.chargedCents;
      any = true;
    }
  }
  return any ? sum : null;
}

function modelMatches(
  eventModel: string | undefined,
  wanted: string | null,
): boolean {
  if (!wanted) return false;
  if (!eventModel) return false;
  const a = eventModel.toLowerCase();
  const b = wanted.toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Pick the best usage event for a stop-hook turn: prefer model match, then
 * most recent timestamp within the lookback window.
 *
 * A turn that reports a user email is only ever priced from that user's events —
 * borrowing a teammate's event would bill their spend to this repository.
 */
export function selectUsageEventForStopHook(
  events: FilteredUsageEvent[],
  opts: {
    userEmail: string | null;
    model: string | null;
    excludeFingerprints?: ReadonlySet<string>;
    /** When set, pick the event closest to this time instead of the newest. */
    anchorMs?: number;
    /** Ignore events farther than this from `anchorMs` (requires anchor). */
    maxDistanceMs?: number;
  },
): FilteredUsageEvent | null {
  if (events.length === 0) return null;

  const email = opts.userEmail?.trim().toLowerCase() || null;
  const excluded = opts.excludeFingerprints;
  let candidates = events;
  if (email) {
    candidates = events.filter(
      (e) => (e.userEmail ?? '').trim().toLowerCase() === email,
    );
  }
  if (excluded && excluded.size > 0) {
    candidates = candidates.filter(
      (e) => !excluded.has(usageEventFingerprint(e)),
    );
  }
  // Heuristic matching must not steal events that join to a conversation.
  candidates = candidates.filter((e) => usageEventConversationId(e) == null);
  if (candidates.length === 0) return null;

  const withModel = candidates.filter((e) =>
    modelMatches(e.model, opts.model),
  );
  const pool = withModel.length > 0 ? withModel : candidates;

  const anchorMs = opts.anchorMs;
  const maxDistanceMs = opts.maxDistanceMs;
  let best: FilteredUsageEvent | null = null;
  let bestTs = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const event of pool) {
    const ts = parseEventTimestampMs(event.timestamp);
    if (anchorMs != null) {
      const dist = Math.abs(ts - anchorMs);
      if (maxDistanceMs != null && dist > maxDistanceMs) continue;
      if (dist < bestDist || (dist === bestDist && ts > bestTs)) {
        best = event;
        bestDist = dist;
        bestTs = ts;
      }
      continue;
    }
    if (ts >= bestTs) {
      best = event;
      bestTs = ts;
    }
  }
  return best;
}

/**
 * Assign usage events to stop hooks by `conversationId` (the join key on
 * `/teams/filtered-usage-events`). Multiple events in one conversation are
 * summed onto the nearest hook in that conversation.
 */
export function assignUsageEventsByConversation(
  hooks: PendingHookCostRow[],
  events: FilteredUsageEvent[],
  used: Set<string>,
): Map<string, FilteredUsageEvent[]> {
  const assigned = new Map<string, FilteredUsageEvent[]>();
  const hooksByConv = new Map<string, PendingHookCostRow[]>();
  for (const hook of hooks) {
    const id = normalizeConversationId(hook.conversationId);
    if (!id) continue;
    const list = hooksByConv.get(id) ?? [];
    list.push(hook);
    hooksByConv.set(id, list);
  }
  if (hooksByConv.size === 0) return assigned;

  const eventsByConv = new Map<string, FilteredUsageEvent[]>();
  for (const event of events) {
    if (used.has(usageEventFingerprint(event))) continue;
    const id = usageEventConversationId(event);
    if (!id || !hooksByConv.has(id)) continue;
    const list = eventsByConv.get(id) ?? [];
    list.push(event);
    eventsByConv.set(id, list);
  }

  for (const [convId, convHooks] of hooksByConv) {
    const ordered = [...convHooks].sort((a, b) => hookAnchorMs(a) - hookAnchorMs(b));
    const buckets = new Map<string, FilteredUsageEvent[]>();
    for (const hook of ordered) buckets.set(hook.id, []);

    const convEvents = eventsByConv.get(convId) ?? [];
    for (const event of convEvents) {
      const te = parseEventTimestampMs(event.timestamp);
      let best = ordered[0]!;
      let bestDist = Math.abs(te - hookAnchorMs(best));
      for (let i = 1; i < ordered.length; i += 1) {
        const hook = ordered[i]!;
        const dist = Math.abs(te - hookAnchorMs(hook));
        if (dist < bestDist) {
          best = hook;
          bestDist = dist;
        }
      }
      buckets.get(best.id)!.push(event);
      used.add(usageEventFingerprint(event));
    }

    for (const [hookId, matched] of buckets) {
      assigned.set(hookId, matched);
    }
  }
  return assigned;
}

export function lookupFromMatchedEvents(
  matched: FilteredUsageEvent[],
  opts: { source: string; conversationId?: string | null },
): HookUsageCostLookup {
  const charged = sumChargedCents(matched);
  const conversationId =
    normalizeConversationId(opts.conversationId) ??
    (matched[0] ? usageEventConversationId(matched[0]) : null);
  const usageEvent =
    matched.length === 1
      ? { ...matched[0] }
      : {
          conversationId,
          chargedCents: charged,
          eventCount: matched.length,
          events: matched,
        };
  return {
    chargedCents: charged,
    costSource: conversationId
      ? `${opts.source}:conversationId`
      : opts.source,
    usageEvent,
    costLookupError:
      charged == null ? 'Matched usage event lacked chargedCents' : null,
  };
}

export async function fetchTeamUsageEvents(opts: {
  client: CursorAdminClient;
  email: string | null;
  startDate: number;
  endDate: number;
}): Promise<FilteredUsageEvent[]> {
  const body = {
    startDate: opts.startDate,
    endDate: opts.endDate,
    page: 1,
    pageSize: 100,
    ...(opts.email ? { email: opts.email } : {}),
  };
  const res = await opts.client.filteredUsageEvents(body);
  return res.usageEvents ?? res.events ?? [];
}

/** Page every Team usage event in the window (manual historical backfill). */
export async function fetchAllTeamUsageEvents(opts: {
  client: CursorAdminClient;
  email: string | null;
  startDate: number;
  endDate: number;
  pageSize?: number;
  maxPages?: number;
}): Promise<{ events: FilteredUsageEvent[]; truncated: boolean }> {
  const listed = await opts.client.listAllFilteredUsageEvents(
    {
      startDate: opts.startDate,
      endDate: opts.endDate,
      ...(opts.email ? { email: opts.email } : {}),
    },
    {
      pageSize: opts.pageSize ?? HOOK_COST_BACKFILL_PAGE_SIZE,
      maxPages: opts.maxPages ?? HOOK_COST_BACKFILL_MAX_PAGES,
    },
  );
  return { events: listed.items, truncated: listed.truncated };
}

export function lookupFromUsageEvents(
  events: FilteredUsageEvent[],
  opts: {
    userEmail: string | null;
    model: string | null;
    source: string;
    lookbackMs?: number;
    excludeFingerprints?: ReadonlySet<string>;
    anchorMs?: number;
    maxDistanceMs?: number;
    conversationId?: string | null;
  },
): HookUsageCostLookup {
  const conversationId = normalizeConversationId(opts.conversationId);
  if (conversationId) {
    const used = new Set(opts.excludeFingerprints ?? []);
    const matched = events.filter((event) => {
      if (used.has(usageEventFingerprint(event))) return false;
      if (usageEventConversationId(event) !== conversationId) return false;
      if (opts.anchorMs != null && opts.maxDistanceMs != null) {
        const ts = parseEventTimestampMs(event.timestamp);
        if (Math.abs(ts - opts.anchorMs) > opts.maxDistanceMs) return false;
      }
      return true;
    });
    if (matched.length === 0) {
      return {
        chargedCents: null,
        costSource: opts.source,
        usageEvent: null,
        costLookupError: `No usage events for conversation ${conversationId}`,
      };
    }
    return lookupFromMatchedEvents(matched, {
      source: opts.source,
      conversationId,
    });
  }

  const matched = selectUsageEventForStopHook(events, opts);
  if (!matched) {
    const window = `${Math.round((opts.lookbackMs ?? DEFAULT_LOOKBACK_MS) / 60000)}m`;
    const email = opts.userEmail?.trim() || null;
    return {
      chargedCents: null,
      costSource: opts.source,
      usageEvent: null,
      costLookupError: email
        ? `No usage events for ${email} in the last ${window}`
        : `No usage events matched in the last ${window}`,
    };
  }

  const charged =
    typeof matched.chargedCents === 'number' &&
    Number.isFinite(matched.chargedCents)
      ? matched.chargedCents
      : null;

  return {
    chargedCents: charged,
    costSource: opts.source,
    usageEvent: { ...matched },
    costLookupError:
      charged == null
        ? 'Matched usage event lacked chargedCents'
        : opts.userEmail?.trim()
          ? null
          : 'Turn reported no user email — cost comes from the newest matching usage event and may belong to another user',
  };
}

function envTeamCredential(): TeamCostCredential | null {
  const apiKey = teamApiKeyFromEnv();
  if (!apiKey) return null;
  const baseUrl = normalizeCursorBaseUrl(process.env.CURSOR_API_BASE_URL);
  if (!baseUrl.ok) return null;
  return {
    apiKey,
    baseUrl: baseUrl.value,
    source: 'env',
    label: 'env CURSOR_TEAM_API_KEY',
  };
}

function teamKeysFromOrganisation(
  org: DecryptedCursorOrganisation,
): TeamCostCredential[] {
  const baseUrl = normalizeCursorBaseUrl(org.baseUrl);
  if (!baseUrl.ok) return [];
  return org.apiKeys
    .filter((key: DecryptedCursorApiKey) => key.keyKind === 'service_account')
    .map((key) => ({
      apiKey: key.apiKey,
      baseUrl: baseUrl.value,
      source: 'db' as const,
      label: `${org.label} · ${key.label}`,
    }));
}

/**
 * Team Admin keys used for `/teams/filtered-usage-events`.
 * Prefers encrypted Team keys on Cursor organisation connections; env fallback.
 */
export async function resolveTeamCostCredentials(
  ctx: ServiceContext,
): Promise<TeamCostCredential[]> {
  const out: TeamCostCredential[] = [];
  const seen = new Set<string>();
  const push = (cred: TeamCostCredential) => {
    const token = `${cred.baseUrl}|${cred.apiKey}`;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(cred);
  };

  try {
    const orgs = await listCursorOrganisations(ctx);
    for (const org of orgs) {
      for (const cred of teamKeysFromOrganisation(org)) push(cred);
    }
  } catch {
    // Listing credentials must not fail the whole reconcile; env may still work.
  }

  const envCred = envTeamCredential();
  if (envCred) push(envCred);
  return out;
}

export async function resolveTeamCostCredentialsForAllOrgs(
  db: Db = getDb(),
): Promise<TeamCostCredential[]> {
  const rows = await db.query.orgs.findMany();
  const out: TeamCostCredential[] = [];
  const seen = new Set<string>();
  for (const org of rows) {
    const ctx = createContext({
      db,
      orgId: org.id,
      actor: { kind: 'system', reason: 'reconcile_stop_hook_costs' },
      flags: createFlagReader(db),
      logger: silentLogger,
    });
    for (const cred of await resolveTeamCostCredentials(ctx)) {
      const token = `${cred.baseUrl}|${cred.apiKey}`;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(cred);
    }
  }
  if (out.length === 0) {
    const envCred = envTeamCredential();
    if (envCred) out.push(envCred);
  }
  return out;
}

export async function lookupStopHookUsageCost(input: {
  userEmail: string | null;
  model: string | null;
  now?: Date;
  lookbackMs?: number;
  credentials?: TeamCostCredential[];
  fetchEvents?: typeof fetchTeamUsageEvents;
}): Promise<HookUsageCostLookup> {
  const now = input.now ?? new Date();
  const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const endDate = now.getTime();
  const startDate = endDate - lookbackMs;
  const email = input.userEmail?.trim() || null;
  const fetchEvents = input.fetchEvents ?? fetchTeamUsageEvents;
  const credentials = input.credentials ?? [];

  if (credentials.length === 0) {
    return {
      chargedCents: null,
      costSource: null,
      usageEvent: null,
      costLookupError:
        'No Cursor Team API key configured for usage-events lookup. Add a Team API key in Monitoring or Settings → Organisations (or set CURSOR_TEAM_API_KEY).',
    };
  }

  const errors: string[] = [];
  for (const cred of credentials) {
    try {
      const client = createCursorAdminClient({
        apiKey: cred.apiKey,
        baseUrl: cred.baseUrl,
        maxRetries: 0,
      });
      const events = await fetchEvents({
        client,
        email,
        startDate,
        endDate,
      });
      const result = lookupFromUsageEvents(events, {
        userEmail: email,
        model: input.model,
        source: `${HOOK_COST_TEAM_SOURCE}:${cred.source}`,
        lookbackMs,
      });
      if (result.chargedCents != null) return result;
      if (result.costLookupError) errors.push(result.costLookupError);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${cred.label}: ${message.slice(0, 240)}`);
    }
  }

  return {
    chargedCents: null,
    costSource: `${HOOK_COST_TEAM_SOURCE}:unmatched`,
    usageEvent: null,
    costLookupError: errors[0] ?? 'No matching Team usage events',
  };
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function mapHookCostRow(
  row: {
    id: string;
    userEmail: string | null;
    model: string | null;
    conversationId?: string | null;
    receivedAt: Date | string;
    finishedAt: Date | string | null;
    startedAt?: Date | string | null;
  },
  now: Date,
): PendingHookCostRow {
  return {
    id: row.id,
    userEmail: row.userEmail,
    model: row.model,
    conversationId: normalizeConversationId(row.conversationId),
    receivedAt: asDate(row.receivedAt) ?? now,
    finishedAt: asDate(row.finishedAt),
    startedAt: asDate(row.startedAt ?? null),
  };
}

export async function loadPendingHookCostRows(opts: {
  now: Date;
  delayMs: number;
  maxAgeMs: number;
  cadenceMs: number;
  limit?: number;
}): Promise<PendingHookCostRow[]> {
  const now = opts.now;
  const youngest = new Date(now.getTime() - opts.delayMs);
  const oldest = new Date(now.getTime() - opts.maxAgeMs - opts.cadenceMs);
  const retryBefore = new Date(now.getTime() - opts.cadenceMs);
  const rows = await getDb()
    .select({
      id: cursorStopHookEvents.id,
      userEmail: cursorStopHookEvents.userEmail,
      model: cursorStopHookEvents.model,
      conversationId: cursorStopHookEvents.conversationId,
      receivedAt: cursorStopHookEvents.receivedAt,
      finishedAt: cursorStopHookEvents.finishedAt,
      startedAt: cursorStopHookEvents.startedAt,
    })
    .from(cursorStopHookEvents)
    .where(
      and(
        isNull(cursorStopHookEvents.chargedCents),
        lte(cursorStopHookEvents.receivedAt, youngest),
        gte(cursorStopHookEvents.receivedAt, oldest),
        or(
          isNull(cursorStopHookEvents.costLookedUpAt),
          lte(cursorStopHookEvents.costLookedUpAt, retryBefore),
        ),
      ),
    )
    .orderBy(cursorStopHookEvents.receivedAt)
    .limit(opts.limit ?? 200);

  return rows.map((row) => mapHookCostRow(row, now));
}

export async function loadEarliestStopHookReceivedAt(): Promise<Date | null> {
  const rows = await getDb()
    .select({ receivedAt: cursorStopHookEvents.receivedAt })
    .from(cursorStopHookEvents)
    .orderBy(asc(cursorStopHookEvents.receivedAt))
    .limit(1);
  return asDate(rows[0]?.receivedAt ?? null);
}

/** Every unpriced stop hook, oldest first — no cadence delay or max-age window. */
export async function loadUnpricedHookCostRows(opts?: {
  fromReceivedAt?: Date;
  limit?: number;
}): Promise<PendingHookCostRow[]> {
  const now = new Date();
  const limit = opts?.limit ?? HOOK_COST_BACKFILL_LIMIT;
  const filters = [isNull(cursorStopHookEvents.chargedCents)];
  if (opts?.fromReceivedAt) {
    filters.push(gte(cursorStopHookEvents.receivedAt, opts.fromReceivedAt));
  }
  const rows = await getDb()
    .select({
      id: cursorStopHookEvents.id,
      userEmail: cursorStopHookEvents.userEmail,
      model: cursorStopHookEvents.model,
      conversationId: cursorStopHookEvents.conversationId,
      receivedAt: cursorStopHookEvents.receivedAt,
      finishedAt: cursorStopHookEvents.finishedAt,
      startedAt: cursorStopHookEvents.startedAt,
    })
    .from(cursorStopHookEvents)
    .where(and(...filters))
    .orderBy(asc(cursorStopHookEvents.receivedAt))
    .limit(limit);

  return rows.map((row) => mapHookCostRow(row, now));
}

/** Every stop hook from `fromReceivedAt`, including rows that already have cost. */
export async function loadAllHookCostRowsFrom(opts?: {
  fromReceivedAt?: Date;
  limit?: number;
}): Promise<PendingHookCostRow[]> {
  const now = new Date();
  const limit = opts?.limit ?? HOOK_COST_BACKFILL_LIMIT;
  const filters = opts?.fromReceivedAt
    ? [gte(cursorStopHookEvents.receivedAt, opts.fromReceivedAt)]
    : [];
  const rows = await getDb()
    .select({
      id: cursorStopHookEvents.id,
      userEmail: cursorStopHookEvents.userEmail,
      model: cursorStopHookEvents.model,
      conversationId: cursorStopHookEvents.conversationId,
      receivedAt: cursorStopHookEvents.receivedAt,
      finishedAt: cursorStopHookEvents.finishedAt,
      startedAt: cursorStopHookEvents.startedAt,
    })
    .from(cursorStopHookEvents)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(cursorStopHookEvents.receivedAt))
    .limit(limit);

  return rows.map((row) => mapHookCostRow(row, now));
}

/** Fingerprints of usage events already attached to priced hooks in the window. */
export async function loadPricedUsageEventFingerprints(opts: {
  fromReceivedAt: Date;
  limit?: number;
}): Promise<Set<string>> {
  const rows = await getDb()
    .select({ usageEvent: cursorStopHookEvents.usageEvent })
    .from(cursorStopHookEvents)
    .where(
      and(
        isNotNull(cursorStopHookEvents.chargedCents),
        gte(cursorStopHookEvents.receivedAt, opts.fromReceivedAt),
      ),
    )
    .limit(opts.limit ?? 20_000);

  const used = new Set<string>();
  for (const row of rows) {
    if (!row.usageEvent || typeof row.usageEvent !== 'object') continue;
    for (const fp of fingerprintsFromStoredUsageEvent(row.usageEvent)) {
      used.add(fp);
    }
  }
  return used;
}

export function fingerprintsFromStoredUsageEvent(
  stored: Record<string, unknown>,
): string[] {
  const nested = stored.events;
  if (Array.isArray(nested)) {
    return nested.flatMap((item) =>
      item && typeof item === 'object'
        ? [usageEventFingerprint(item as FilteredUsageEvent)]
        : [],
    );
  }
  return [usageEventFingerprint(stored as FilteredUsageEvent)];
}

export async function applyHookCostLookup(
  id: string,
  result: HookUsageCostLookup,
  lookedUpAt: Date,
  opts?: { overwrite?: boolean },
): Promise<void> {
  const filters = [eq(cursorStopHookEvents.id, id)];
  if (!opts?.overwrite) {
    filters.push(isNull(cursorStopHookEvents.chargedCents));
  }
  await getDb()
    .update(cursorStopHookEvents)
    .set({
      chargedCents: result.chargedCents,
      costSource: result.costSource,
      costLookupError: result.costLookupError,
      usageEvent: result.usageEvent,
      costLookedUpAt: lookedUpAt,
    })
    .where(and(...filters));
}

export async function fetchUsageEventsForWindow(opts: {
  credentials: TeamCostCredential[];
  startDate: number;
  endDate: number;
  fetchEvents?: FetchTeamUsageEvents;
}): Promise<{
  events: FilteredUsageEvent[];
  source: string;
  errors: string[];
}> {
  const fetchEvents = opts.fetchEvents ?? fetchTeamUsageEvents;
  const events: FilteredUsageEvent[] = [];
  const errors: string[] = [];
  let source = HOOK_COST_TEAM_SOURCE;
  const seen = new Set<string>();

  for (const cred of opts.credentials) {
    try {
      const client = createCursorAdminClient({
        apiKey: cred.apiKey,
        baseUrl: cred.baseUrl,
        maxRetries: 1,
      });
      const batch = await fetchEvents({
        client,
        email: null,
        startDate: opts.startDate,
        endDate: opts.endDate,
      });
      source = `${HOOK_COST_TEAM_SOURCE}:${cred.source}`;
      for (const event of batch) {
        const fp = usageEventFingerprint(event);
        if (seen.has(fp)) continue;
        seen.add(fp);
        events.push(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${cred.label}: ${message.slice(0, 240)}`);
    }
  }

  return { events, source, errors };
}

export function matchPendingHooksToUsageEvents(opts: {
  pending: PendingHookCostRow[];
  events: FilteredUsageEvent[];
  source: string;
  now: Date;
  delayMs: number;
  maxAgeMs: number;
  lookbackMs?: number;
  excludeFingerprints?: ReadonlySet<string>;
  /** When false, unmatched old rows stay pending instead of expiring. */
  expireUnmatched?: boolean;
  /** Match the usage event closest to the hook time (historical backfill). */
  anchorToHook?: boolean;
  maxDistanceMs?: number;
}): Array<{
  row: PendingHookCostRow;
  lookup: HookUsageCostLookup;
  expired: boolean;
}> {
  const used = new Set<string>(opts.excludeFingerprints ?? []);
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const expireUnmatched = opts.expireUnmatched !== false;
  const byConversation = assignUsageEventsByConversation(
    opts.pending,
    opts.events,
    used,
  );
  return opts.pending.map((row) => {
    const ageMs = opts.now.getTime() - row.receivedAt.getTime();
    const conversationEvents = normalizeConversationId(row.conversationId)
      ? (byConversation.get(row.id) ?? [])
      : null;
    const lookup =
      conversationEvents && conversationEvents.length > 0
        ? lookupFromMatchedEvents(conversationEvents, {
            source: opts.source,
            conversationId: row.conversationId,
          })
        : conversationEvents
          ? {
              chargedCents: null as number | null,
              costSource: opts.source,
              usageEvent: null as Record<string, unknown> | null,
              costLookupError: `No usage events for conversation ${row.conversationId}`,
            }
          : lookupFromUsageEvents(opts.events, {
              userEmail: row.userEmail,
              model: row.model,
              source: opts.source,
              lookbackMs,
              excludeFingerprints: used,
              ...(opts.anchorToHook
                ? {
                    anchorMs: hookAnchorMs(row),
                    maxDistanceMs: opts.maxDistanceMs,
                  }
                : {}),
            });
    if (lookup.usageEvent && !conversationEvents) {
      const stored = lookup.usageEvent as FilteredUsageEvent & {
        events?: FilteredUsageEvent[];
      };
      if (Array.isArray(stored.events)) {
        for (const event of stored.events) {
          used.add(usageEventFingerprint(event));
        }
      } else {
        used.add(usageEventFingerprint(stored));
      }
    }
    const expired =
      expireUnmatched && lookup.chargedCents == null && ageMs >= opts.maxAgeMs;
    if (expired) {
      return {
        row,
        lookup: {
          ...lookup,
          costLookupError:
            'No Team usage event appeared within 6 hours of this turn',
        },
        expired: true,
      };
    }
    if (lookup.chargedCents == null) {
      return {
        row,
        lookup: {
          chargedCents: null,
          costSource: HOOK_COST_PENDING_SOURCE,
          usageEvent: null,
          costLookupError: null,
        },
        expired: false,
      };
    }
    return { row, lookup, expired: false };
  });
}

export async function reconcileStopHookUsageCosts(opts?: {
  now?: Date;
  delayMs?: number;
  maxAgeMs?: number;
  cadenceMs?: number;
  lookbackPaddingMs?: number;
  loadPending?: typeof loadPendingHookCostRows;
  loadCredentials?: () => Promise<TeamCostCredential[]>;
  loadPricedFingerprints?: typeof loadPricedUsageEventFingerprints;
  fetchEvents?: FetchTeamUsageEvents;
  apply?: typeof applyHookCostLookup;
}): Promise<HookCostReconcileSummary> {
  const now = opts?.now ?? new Date();
  const delayMs = opts?.delayMs ?? HOOK_COST_DELAY_MS;
  const maxAgeMs = opts?.maxAgeMs ?? HOOK_COST_MAX_AGE_MS;
  const cadenceMs = opts?.cadenceMs ?? HOOK_COST_CADENCE_MS;
  const loadPending = opts?.loadPending ?? loadPendingHookCostRows;
  const loadPricedFingerprints =
    opts?.loadPricedFingerprints ?? loadPricedUsageEventFingerprints;
  const apply = opts?.apply ?? applyHookCostLookup;

  const pending = await loadPending({
    now,
    delayMs,
    maxAgeMs,
    cadenceMs,
  });

  const credentials = opts?.loadCredentials
    ? await opts.loadCredentials()
    : await resolveTeamCostCredentialsForAllOrgs();

  if (pending.length === 0) {
    return {
      pending: 0,
      upgraded: 0,
      waiting: 0,
      expired: 0,
      failed: 0,
      skippedYoung: 0,
      credentials: credentials.length,
    };
  }

  if (credentials.length === 0) {
    const lookup: HookUsageCostLookup = {
      chargedCents: null,
      costSource: null,
      usageEvent: null,
      costLookupError:
        'No Cursor Team API key configured for usage-events lookup. Add a Team API key in Monitoring or Settings → Organisations (or set CURSOR_TEAM_API_KEY).',
    };
    for (const row of pending) {
      await apply(row.id, lookup, now);
    }
    return {
      pending: pending.length,
      upgraded: 0,
      waiting: 0,
      expired: 0,
      failed: pending.length,
      skippedYoung: 0,
      credentials: 0,
      message: lookup.costLookupError ?? undefined,
    };
  }

  const startDate =
    Math.min(
      ...pending.map((row) => (row.finishedAt ?? row.receivedAt).getTime()),
    ) - (opts?.lookbackPaddingMs ?? DEFAULT_LOOKBACK_MS);
  const endDate = now.getTime();

  const fetched = await fetchUsageEventsForWindow({
    credentials,
    startDate,
    endDate,
    fetchEvents: opts?.fetchEvents,
  });

  if (fetched.events.length === 0 && fetched.errors.length === credentials.length) {
    const lookup: HookUsageCostLookup = {
      chargedCents: null,
      costSource: null,
      usageEvent: null,
      costLookupError: fetched.errors[0] ?? 'Team usage API failed',
    };
    for (const row of pending) {
      await apply(row.id, lookup, now);
    }
    return {
      pending: pending.length,
      upgraded: 0,
      waiting: 0,
      expired: 0,
      failed: pending.length,
      skippedYoung: 0,
      credentials: credentials.length,
      message: lookup.costLookupError ?? undefined,
    };
  }

  const matched = matchPendingHooksToUsageEvents({
    pending,
    events: fetched.events,
    source: fetched.source,
    now,
    delayMs,
    maxAgeMs,
    excludeFingerprints: await loadPricedFingerprints({
      fromReceivedAt: new Date(startDate),
    }),
  });

  let upgraded = 0;
  let waiting = 0;
  let expired = 0;
  let failed = 0;
  for (const item of matched) {
    await apply(item.row.id, item.lookup, now);
    if (item.lookup.chargedCents != null) upgraded += 1;
    else if (item.expired) expired += 1;
    else if (item.lookup.costLookupError) failed += 1;
    else waiting += 1;
  }

  return {
    pending: pending.length,
    upgraded,
    waiting,
    expired,
    failed,
    skippedYoung: 0,
    credentials: credentials.length,
  };
}

function emptyBackfillSummary(
  extras: Partial<HookCostBackfillSummary> = {},
): HookCostBackfillSummary {
  return {
    fromReceivedAt: null,
    pending: 0,
    upgraded: 0,
    unmatched: 0,
    failed: 0,
    usageEvents: 0,
    usageTruncated: false,
    pendingTruncated: false,
    credentials: 0,
    skippedNoHooks: false,
    skippedNoTeamKey: false,
    ...extras,
  };
}

/**
 * Manual historical backfill: page every Team usage event from the first
 * recorded stop hook through now, join on conversationId (summing every
 * matching usage event), and overwrite previously guessed costs.
 */
export async function reconcileStopHookUsageCostsFromFirstHook(opts?: {
  now?: Date;
  lookbackPaddingMs?: number;
  maxDistanceMs?: number;
  unpricedLimit?: number;
  loadEarliest?: typeof loadEarliestStopHookReceivedAt;
  loadHooks?: typeof loadAllHookCostRowsFrom;
  /** @deprecated Use loadHooks — kept so existing tests keep compiling. */
  loadUnpriced?: typeof loadUnpricedHookCostRows;
  loadPricedFingerprints?: typeof loadPricedUsageEventFingerprints;
  loadCredentials?: () => Promise<TeamCostCredential[]>;
  fetchEvents?: FetchTeamUsageEvents;
  apply?: typeof applyHookCostLookup;
}): Promise<HookCostBackfillSummary> {
  const now = opts?.now ?? new Date();
  const lookbackPaddingMs = opts?.lookbackPaddingMs ?? DEFAULT_LOOKBACK_MS;
  const maxDistanceMs = opts?.maxDistanceMs ?? HOOK_COST_MAX_AGE_MS;
  const unpricedLimit = opts?.unpricedLimit ?? HOOK_COST_BACKFILL_LIMIT;
  const loadEarliest = opts?.loadEarliest ?? loadEarliestStopHookReceivedAt;
  const loadHooks =
    opts?.loadHooks ?? opts?.loadUnpriced ?? loadAllHookCostRowsFrom;
  const apply =
    opts?.apply ??
    ((id, lookup, at) =>
      applyHookCostLookup(id, lookup, at, { overwrite: true }));

  const earliest = await loadEarliest();
  const credentials = opts?.loadCredentials
    ? await opts.loadCredentials()
    : await resolveTeamCostCredentialsForAllOrgs();

  if (!earliest) {
    return emptyBackfillSummary({
      credentials: credentials.length,
      skippedNoHooks: true,
    });
  }

  const pending = await loadHooks({
    fromReceivedAt: earliest,
    limit: unpricedLimit,
  });
  const pendingTruncated = pending.length >= unpricedLimit;

  if (credentials.length === 0) {
    return emptyBackfillSummary({
      fromReceivedAt: earliest.toISOString(),
      pending: pending.length,
      unmatched: pending.length,
      pendingTruncated,
      credentials: 0,
      skippedNoTeamKey: true,
      message:
        'No Cursor Team API key configured for usage-events lookup. Add a Team API key in Monitoring or Settings → Organisations (or set CURSOR_TEAM_API_KEY).',
    });
  }

  if (pending.length === 0) {
    return emptyBackfillSummary({
      fromReceivedAt: earliest.toISOString(),
      pendingTruncated,
      credentials: credentials.length,
    });
  }

  let usageTruncated = false;
  const fetchEvents: FetchTeamUsageEvents =
    opts?.fetchEvents ??
    (async (args) => {
      const listed = await fetchAllTeamUsageEvents({
        ...args,
        pageSize: HOOK_COST_BACKFILL_PAGE_SIZE,
        maxPages: HOOK_COST_BACKFILL_MAX_PAGES,
      });
      usageTruncated = usageTruncated || listed.truncated;
      return listed.events;
    });

  const startDate = earliest.getTime() - lookbackPaddingMs;
  const endDate = now.getTime();
  const fetched = await fetchUsageEventsForWindow({
    credentials,
    startDate,
    endDate,
    fetchEvents,
  });

  if (
    fetched.events.length === 0 &&
    fetched.errors.length === credentials.length
  ) {
    return emptyBackfillSummary({
      fromReceivedAt: earliest.toISOString(),
      pending: pending.length,
      unmatched: pending.length,
      failed: pending.length,
      pendingTruncated,
      credentials: credentials.length,
      message: fetched.errors[0] ?? 'Team usage API failed',
    });
  }

  const matched = matchPendingHooksToUsageEvents({
    pending,
    events: fetched.events,
    source: fetched.source,
    now,
    delayMs: 0,
    maxAgeMs: HOOK_COST_MAX_AGE_MS,
    expireUnmatched: false,
    anchorToHook: true,
    maxDistanceMs,
  });

  let upgraded = 0;
  let unmatched = 0;
  let failed = 0;
  for (const item of matched) {
    if (item.lookup.chargedCents != null) {
      await apply(item.row.id, item.lookup, now);
      upgraded += 1;
      continue;
    }
    if (item.lookup.costLookupError && item.lookup.costSource !== HOOK_COST_PENDING_SOURCE) {
      failed += 1;
      continue;
    }
    unmatched += 1;
  }

  return emptyBackfillSummary({
    fromReceivedAt: earliest.toISOString(),
    pending: pending.length,
    upgraded,
    unmatched,
    failed,
    usageEvents: fetched.events.length,
    usageTruncated,
    pendingTruncated,
    credentials: credentials.length,
    message: usageTruncated
      ? `Usage event list truncated after ${HOOK_COST_BACKFILL_MAX_PAGES} pages — matched what was fetched.`
      : undefined,
  });
}
