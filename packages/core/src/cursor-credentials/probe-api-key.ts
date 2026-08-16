import {
  createCursorAdminClient,
  createCursorClient,
  type ApiKeyInfo,
} from '@nexus/cursor-client';
import { normalizeCursorBaseUrl } from './base-url';

export type CursorApiKeyProbeKind = 'user' | 'team';

export type CursorApiKeyProbeOk = {
  ok: true;
  kind: CursorApiKeyProbeKind;
  identity: string;
  note: string;
  me: ApiKeyInfo | null;
};

export type CursorApiKeyProbeErr = {
  ok: false;
  error: string;
  looksLikeUserKey: boolean;
};

export type CursorApiKeyProbe = CursorApiKeyProbeOk | CursorApiKeyProbeErr;

const MIN_KEY_LENGTH = 20;

export function isUserScopedApiKey(me: ApiKeyInfo | null | undefined): boolean {
  if (!me) return false;
  if (typeof me.userEmail === 'string' && me.userEmail.trim()) return true;
  if (typeof me.userId === 'number' && Number.isFinite(me.userId)) return true;
  if (typeof me.userFirstName === 'string' && me.userFirstName.trim()) {
    return true;
  }
  if (typeof me.userLastName === 'string' && me.userLastName.trim()) {
    return true;
  }
  return false;
}

export function formatCursorApiKeyIdentity(me: ApiKeyInfo | null): string {
  if (!me) return 'Team API key';
  const nameParts = [me.userFirstName, me.userLastName].filter(Boolean);
  const person = nameParts.length
    ? nameParts.join(' ')
    : me.userEmail
      ? me.userEmail
      : null;
  const keyName = me.apiKeyName ?? 'API key';
  if (person) return `${person} · ${keyName}`;
  return `${keyName} (service account / team key)`;
}

function invalidKeyMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isInvalidTeamApiKeyError(message: string): boolean {
  return /invalid team api key|not a team|user api key/i.test(message);
}

async function readMe(opts: {
  apiKey: string;
  baseUrl: string;
}): Promise<{ me: ApiKeyInfo | null; error: string | null }> {
  try {
    const client = createCursorClient({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      maxRetries: 0,
    });
    const me = await client.getMe();
    return { me, error: null };
  } catch (err) {
    return { me: null, error: invalidKeyMessage(err) };
  }
}

/**
 * Prove a User API key via GET /v1/me. Team Admin keys typically fail this
 * endpoint or omit user identity fields.
 */
export async function probeUserApiKey(opts: {
  apiKey: string;
  baseUrl?: string | null;
}): Promise<CursorApiKeyProbe> {
  const apiKey = opts.apiKey.trim();
  if (apiKey.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      error: 'Paste a Cursor User API key (at least 20 characters).',
      looksLikeUserKey: false,
    };
  }
  const baseUrlResult = normalizeCursorBaseUrl(opts.baseUrl);
  if (!baseUrlResult.ok) {
    return {
      ok: false,
      error: baseUrlResult.error.message,
      looksLikeUserKey: false,
    };
  }

  const { me, error } = await readMe({
    apiKey,
    baseUrl: baseUrlResult.value,
  });
  if (!me) {
    return {
      ok: false,
      error: error
        ? `Key rejected by Cursor (/v1/me): ${error}`
        : 'Key rejected by Cursor (/v1/me).',
      looksLikeUserKey: false,
    };
  }
  if (!isUserScopedApiKey(me)) {
    return {
      ok: false,
      error:
        'This looks like a Team API key (no user identity on /v1/me). Select Team and save it as a Team API key.',
      looksLikeUserKey: false,
    };
  }
  const identity = formatCursorApiKeyIdentity(me);
  return {
    ok: true,
    kind: 'user',
    identity,
    note: `Valid User API key · ${identity}`,
    me,
  };
}

/**
 * Prove a Team Admin API key can call the usage API
 * (`POST /teams/filtered-usage-events`). User keys fail this with
 * `401 Invalid Team API Key`.
 */
export async function probeTeamApiKey(opts: {
  apiKey: string;
  baseUrl?: string | null;
  nowMs?: number;
}): Promise<CursorApiKeyProbe> {
  const apiKey = opts.apiKey.trim();
  if (apiKey.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      error: 'Paste a Cursor Team API key (at least 20 characters).',
      looksLikeUserKey: false,
    };
  }
  const baseUrlResult = normalizeCursorBaseUrl(opts.baseUrl);
  if (!baseUrlResult.ok) {
    return {
      ok: false,
      error: baseUrlResult.error.message,
      looksLikeUserKey: false,
    };
  }
  const baseUrl = baseUrlResult.value;

  const { me } = await readMe({ apiKey, baseUrl });
  if (isUserScopedApiKey(me)) {
    const identity = formatCursorApiKeyIdentity(me);
    return {
      ok: false,
      error: `This is a User API key (${identity}). Monitoring cost needs a Team API key from Cursor Dashboard → Settings → API Keys (team), not a personal user key.`,
      looksLikeUserKey: true,
    };
  }

  const admin = createCursorAdminClient({
    apiKey,
    baseUrl,
    maxRetries: 0,
  });
  const end = opts.nowMs ?? Date.now();
  const start = end - 60 * 60 * 1000;
  try {
    const res = await admin.filteredUsageEvents({
      startDate: start,
      endDate: end,
      page: 1,
      pageSize: 1,
    });
    const count =
      typeof res.totalUsageEventsCount === 'number'
        ? res.totalUsageEventsCount
        : (res.usageEvents?.length ?? res.events?.length ?? 0);
    const identity = me ? formatCursorApiKeyIdentity(me) : 'Team API key';
    return {
      ok: true,
      kind: 'team',
      identity,
      note: `Valid Team API key · usage events accepted${count != null ? ` (${count} in last hour window)` : ''}`,
      me,
    };
  } catch (err) {
    const message = invalidKeyMessage(err);
    if (isInvalidTeamApiKeyError(message) || /401|403|unauthorized|forbidden/i.test(message)) {
      return {
        ok: false,
        error: `Not a Team API key: ${message}. Create a Team API key in Cursor Dashboard → Settings → API Keys (team tab) with usage access.`,
        looksLikeUserKey: isInvalidTeamApiKeyError(message),
      };
    }
    return {
      ok: false,
      error: `Team usage API rejected the key: ${message}`,
      looksLikeUserKey: false,
    };
  }
}
