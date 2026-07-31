import {
  createCursorAdminClient,
  type CursorAdminClient,
  type FilteredUsageEvent,
} from '@nexus/cursor-client';

export type HookUsageCostLookup = {
  chargedCents: number | null;
  costSource: string | null;
  usageEvent: Record<string, unknown> | null;
  costLookupError: string | null;
};

const DEFAULT_LOOKBACK_MS = 20 * 60 * 1000;

function orgApiKey(): string | null {
  const value =
    process.env.CURSOR_ORGANIZATION_API_KEY?.trim() ||
    process.env.CURSOR_ORG_API_KEY?.trim() ||
    process.env.CURSOR_ADMIN_API_KEY?.trim() ||
    '';
  return value || null;
}

function teamApiKey(): string | null {
  const value =
    process.env.CURSOR_TEAM_API_KEY?.trim() ||
    process.env.CURSOR_ADMIN_API_KEY?.trim() ||
    '';
  return value || null;
}

function organizationId(): string | null {
  const value =
    process.env.CURSOR_ORGANIZATION_ID?.trim() ||
    process.env.CURSOR_ORG_ID?.trim() ||
    '';
  return value || null;
}

function parseEventTimestampMs(raw: string | undefined): number {
  if (!raw) return 0;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : 0;
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
 */
export function selectUsageEventForStopHook(
  events: FilteredUsageEvent[],
  opts: { userEmail: string | null; model: string | null },
): FilteredUsageEvent | null {
  if (events.length === 0) return null;

  const email = opts.userEmail?.trim().toLowerCase() || null;
  let candidates = events;
  if (email) {
    const byEmail = events.filter(
      (e) => (e.userEmail ?? '').trim().toLowerCase() === email,
    );
    if (byEmail.length > 0) candidates = byEmail;
  }

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

async function fetchUsageEvents(opts: {
  client: CursorAdminClient;
  mode: 'org' | 'team';
  organizationId?: string;
  email: string | null;
  startDate: number;
  endDate: number;
}): Promise<FilteredUsageEvent[]> {
  const body = {
    startDate: opts.startDate,
    endDate: opts.endDate,
    page: 1,
    pageSize: 50,
    ...(opts.email ? { email: opts.email } : {}),
  };

  const res =
    opts.mode === 'org'
      ? await opts.client.filteredOrgUsageEvents({
          ...body,
          organizationId: opts.organizationId!,
        })
      : await opts.client.filteredUsageEvents(body);

  return res.usageEvents ?? res.events ?? [];
}

/**
 * Look up chargedCents for a stop-hook turn via Cursor Admin usage events.
 * Prefers Organization Admin API (`/organizations/filtered-usage-events`),
 * falls back to team Admin API. Never throws — returns an error string instead.
 */
export async function lookupStopHookUsageCost(input: {
  userEmail: string | null;
  model: string | null;
  now?: Date;
  lookbackMs?: number;
  fetchEvents?: typeof fetchUsageEvents;
}): Promise<HookUsageCostLookup> {
  const now = input.now ?? new Date();
  const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const endDate = now.getTime();
  const startDate = endDate - lookbackMs;
  const email = input.userEmail?.trim() || null;
  const fetchEvents = input.fetchEvents ?? fetchUsageEvents;

  const orgId = organizationId();
  const orgKey = orgApiKey();
  const teamKey = teamApiKey();

  try {
    let events: FilteredUsageEvent[] = [];
    let source: string | null = null;

    if (orgId && orgKey) {
      const client = createCursorAdminClient({ apiKey: orgKey });
      events = await fetchEvents({
        client,
        mode: 'org',
        organizationId: orgId,
        email,
        startDate,
        endDate,
      });
      source = 'organizations.filtered-usage-events';
    } else if (teamKey) {
      const client = createCursorAdminClient({ apiKey: teamKey });
      events = await fetchEvents({
        client,
        mode: 'team',
        email,
        startDate,
        endDate,
      });
      source = 'teams.filtered-usage-events';
    } else {
      return {
        chargedCents: null,
        costSource: null,
        usageEvent: null,
        costLookupError:
          'No Cursor Admin/Organization API key configured for usage-events lookup',
      };
    }

    const matched = selectUsageEventForStopHook(events, {
      userEmail: email,
      model: input.model,
    });

    if (!matched) {
      return {
        chargedCents: null,
        costSource: source,
        usageEvent: null,
        costLookupError: `No usage events matched in the last ${Math.round(lookbackMs / 60000)}m`,
      };
    }

    const charged =
      typeof matched.chargedCents === 'number' &&
      Number.isFinite(matched.chargedCents)
        ? matched.chargedCents
        : null;

    return {
      chargedCents: charged,
      costSource: source,
      usageEvent: { ...matched },
      costLookupError:
        charged == null
          ? 'Matched usage event lacked chargedCents'
          : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      chargedCents: null,
      costSource: null,
      usageEvent: null,
      costLookupError: message.slice(0, 500),
    };
  }
}
