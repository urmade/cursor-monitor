import {
  createCursorAdminClient,
  type CursorAdminClient,
  type FilteredUsageEvent,
} from '@nexus/cursor-client';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
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
  receivedAt: Date;
  finishedAt: Date | null;
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

export function usageEventFingerprint(event: FilteredUsageEvent): string {
  return [
    event.timestamp ?? '',
    event.userEmail ?? '',
    event.model ?? '',
    String(event.chargedCents ?? ''),
    event.cloudAgentId ?? '',
    String(event.teamId ?? ''),
  ].join('|');
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
  if (candidates.length === 0) return null;

  const withModel = candidates.filter((e) =>
    modelMatches(e.model, opts.model),
  );
  const pool = withModel.length > 0 ? withModel : candidates;

  let best: FilteredUsageEvent | null = null;
  let bestTs = -1;
  for (const event of pool) {
    const ts = parseEventTimestampMs(event.timestamp);
    if (ts >= bestTs) {
      best = event;
      bestTs = ts;
    }
  }
  return best;
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

export function lookupFromUsageEvents(
  events: FilteredUsageEvent[],
  opts: {
    userEmail: string | null;
    model: string | null;
    source: string;
    lookbackMs?: number;
    excludeFingerprints?: ReadonlySet<string>;
  },
): HookUsageCostLookup {
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
      receivedAt: cursorStopHookEvents.receivedAt,
      finishedAt: cursorStopHookEvents.finishedAt,
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

  return rows.map((row) => ({
    id: row.id,
    userEmail: row.userEmail,
    model: row.model,
    receivedAt: asDate(row.receivedAt) ?? now,
    finishedAt: asDate(row.finishedAt),
  }));
}

export async function applyHookCostLookup(
  id: string,
  result: HookUsageCostLookup,
  lookedUpAt: Date,
): Promise<void> {
  await getDb()
    .update(cursorStopHookEvents)
    .set({
      chargedCents: result.chargedCents,
      costSource: result.costSource,
      costLookupError: result.costLookupError,
      usageEvent: result.usageEvent,
      costLookedUpAt: lookedUpAt,
    })
    .where(
      and(
        eq(cursorStopHookEvents.id, id),
        isNull(cursorStopHookEvents.chargedCents),
      ),
    );
}

export async function fetchUsageEventsForWindow(opts: {
  credentials: TeamCostCredential[];
  startDate: number;
  endDate: number;
  fetchEvents?: typeof fetchTeamUsageEvents;
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
}): Array<{
  row: PendingHookCostRow;
  lookup: HookUsageCostLookup;
  expired: boolean;
}> {
  const used = new Set<string>();
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  return opts.pending.map((row) => {
    const ageMs = opts.now.getTime() - row.receivedAt.getTime();
    const lookup = lookupFromUsageEvents(opts.events, {
      userEmail: row.userEmail,
      model: row.model,
      source: opts.source,
      lookbackMs,
      excludeFingerprints: used,
    });
    if (lookup.usageEvent) {
      const matched = lookup.usageEvent as FilteredUsageEvent;
      used.add(usageEventFingerprint(matched));
    }
    const expired = lookup.chargedCents == null && ageMs >= opts.maxAgeMs;
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
  fetchEvents?: typeof fetchTeamUsageEvents;
  apply?: typeof applyHookCostLookup;
}): Promise<HookCostReconcileSummary> {
  const now = opts?.now ?? new Date();
  const delayMs = opts?.delayMs ?? HOOK_COST_DELAY_MS;
  const maxAgeMs = opts?.maxAgeMs ?? HOOK_COST_MAX_AGE_MS;
  const cadenceMs = opts?.cadenceMs ?? HOOK_COST_CADENCE_MS;
  const loadPending = opts?.loadPending ?? loadPendingHookCostRows;
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
