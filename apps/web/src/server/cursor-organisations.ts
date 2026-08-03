'use server';

import { revalidatePath } from 'next/cache';
import {
  createCursorAdminClient,
  createCursorClient,
  createCursorOrgClient,
  discoverOrganizationId,
  normalizeOrganizationId,
  type ApiKeyInfo,
} from '@nexus/cursor-client';
import {
  addCursorOrganisationApiKey,
  checkRateLimit,
  deleteAllCursorOrganisations,
  deleteCursorOrganisation,
  listCursorOrganisationViews as listDbOrganisationViews,
  revokeCursorOrganisationApiKey,
  updateCursorOrganisationApiKey,
  upsertCursorOrganisation,
  type CursorApiKeyKind,
  type CursorOrganisationView as DbOrganisationView,
} from '@nexus/core';
import { formatApiKeyIdentity } from './cursor';
import {
  clearCursorOrganisations,
  maskApiKey,
  normalizeBaseUrl,
  organisationCredentialFingerprint,
  readCursorOrganisations,
  type CursorOrganisationView,
  type StoredCursorOrganisation,
} from './cursor-org-store';
import { currentUser } from './identity';
import { requireSession } from './session';

export type {
  CursorOrganisationView,
  StoredCursorOrganisation,
} from './cursor-org-store';

export type OrganisationCostProbe = {
  pooledUsageOk: boolean;
  usageEventsOk: boolean;
  usedCents: number | null;
  remainingCents: number | null;
  limitCents: number | null;
  recentEventsCount: number | null;
  note: string | null;
};

export type UpsertOrganisationResult =
  | {
      ok: true;
      id: string;
      organizationId: string | null;
      discoveryNote: string | null;
      identity: string | null;
      cost: OrganisationCostProbe | null;
    }
  | { ok: false; error: string };

export type AddApiKeyResult =
  | {
      ok: true;
      id: string;
      identity: string | null;
      keyKind: CursorApiKeyKind;
    }
  | { ok: false; error: string };

export type UpdateApiKeyResult =
  | {
      ok: true;
      id: string;
      identity: string | null;
      keyKind: CursorApiKeyKind;
      label: string;
    }
  | { ok: false; error: string };

export type OrganisationMutationResult =
  | { ok: true }
  | { ok: false; error: string };

export type ValidateApiKeyResult =
  | {
      ok: true;
      kind: 'user_team' | 'organisation';
      identity: string | null;
      note: string;
    }
  | { ok: false; error: string };

function parseKeyKind(raw: string): CursorApiKeyKind {
  // UI calls these User / Team; storage keeps service_account for team keys.
  return raw === 'service_account' || raw === 'team'
    ? 'service_account'
    : 'user';
}

/**
 * Verify Organization Admin cost endpoints with the given key + org id.
 * Used when saving Settings → Organisations so cost wiring is proven before persist.
 * Not exported — must not be callable as a public server action.
 */
async function probeOrganisationCost(opts: {
  orgApiKey: string;
  organizationId: string;
  baseUrl: string;
}): Promise<OrganisationCostProbe> {
  const baseUrlResult = normalizeBaseUrl(opts.baseUrl);
  if (!baseUrlResult.ok) {
    return {
      pooledUsageOk: false,
      usageEventsOk: false,
      usedCents: null,
      remainingCents: null,
      limitCents: null,
      recentEventsCount: null,
      note: baseUrlResult.error.message,
    };
  }
  const baseUrl = baseUrlResult.value;

  const orgClient = createCursorOrgClient({
    apiKey: opts.orgApiKey,
    baseUrl,
    maxRetries: 0,
  });
  const adminClient = createCursorAdminClient({
    apiKey: opts.orgApiKey,
    baseUrl,
    maxRetries: 0,
  });

  let pooledUsageOk = false;
  let usedCents: number | null = null;
  let remainingCents: number | null = null;
  let limitCents: number | null = null;
  let pooledError: string | null = null;

  try {
    const pooled = await orgClient.pooledUsage(opts.organizationId);
    pooledUsageOk = true;
    usedCents =
      typeof pooled.pool?.usedCents === 'number' ? pooled.pool.usedCents : null;
    remainingCents =
      typeof pooled.pool?.remainingCents === 'number'
        ? pooled.pool.remainingCents
        : null;
    limitCents =
      typeof pooled.pool?.limitCents === 'number' ? pooled.pool.limitCents : null;
  } catch (err) {
    pooledError = err instanceof Error ? err.message : String(err);
  }

  let usageEventsOk = false;
  let recentEventsCount: number | null = null;
  let eventsError: string | null = null;
  try {
    const end = Date.now();
    const start = end - 60 * 60 * 1000;
    const res = await adminClient.filteredOrgUsageEvents({
      organizationId: opts.organizationId,
      startDate: start,
      endDate: end,
      page: 1,
      pageSize: 5,
    });
    usageEventsOk = true;
    recentEventsCount =
      typeof res.totalUsageEventsCount === 'number'
        ? res.totalUsageEventsCount
        : (res.usageEvents?.length ?? res.events?.length ?? 0);
  } catch (err) {
    eventsError = err instanceof Error ? err.message : String(err);
  }

  const bits: string[] = [];
  if (pooledUsageOk && usedCents != null) {
    bits.push(
      `pooled usage ${(usedCents / 100).toFixed(2)} used` +
        (remainingCents != null
          ? ` / ${(remainingCents / 100).toFixed(2)} remaining`
          : ''),
    );
  } else if (pooledError) {
    bits.push(`pooled-usage failed: ${pooledError}`);
  }
  if (usageEventsOk) {
    bits.push(
      `usage events ok${recentEventsCount != null ? ` (${recentEventsCount} in last hour window)` : ''}`,
    );
  } else if (eventsError) {
    bits.push(`filtered-usage-events failed: ${eventsError}`);
  }

  return {
    pooledUsageOk,
    usageEventsOk,
    usedCents,
    remainingCents,
    limitCents,
    recentEventsCount,
    note: bits.join(' · ') || null,
  };
}

function viewFromDb(org: DbOrganisationView): CursorOrganisationView {
  const primary = org.keys[0] ?? null;
  return {
    id: org.id,
    label: org.label,
    organizationId: org.organizationId,
    baseUrl: org.baseUrl,
    fingerprint: primary?.fingerprint ?? null,
    identity: primary?.identityLabel ?? null,
    hasOrgApiKey: org.hasOrgApiKey,
    orgApiKeyHint: org.orgApiKeyHint,
    apiKeyHint: primary?.hint ?? null,
    canManage: org.canManage,
    canRemove: org.canRemove,
    keys: org.keys.map((key) => ({
      id: key.id,
      label: key.label,
      keyKind: key.keyKind,
      fingerprint: key.fingerprint,
      hint: key.hint,
      identityLabel: key.identityLabel,
      lastValidatedAt: key.lastValidatedAt
        ? key.lastValidatedAt.toISOString()
        : null,
      canEdit: key.canRemove,
      canRemove: key.canRemove,
    })),
    source: 'db',
  };
}

function viewFromCookie(org: StoredCursorOrganisation): CursorOrganisationView {
  const primary = org.apiKeys[0];
  return {
    id: org.id,
    label: org.label,
    organizationId: org.organizationId,
    baseUrl: org.baseUrl,
    fingerprint: organisationCredentialFingerprint(org) || null,
    identity: primary?.identityLabel ?? null,
    hasOrgApiKey: Boolean(org.orgApiKey),
    orgApiKeyHint: org.orgApiKey ? maskApiKey(org.orgApiKey) : null,
    apiKeyHint: primary?.hint ?? (org.apiKey ? maskApiKey(org.apiKey) : null),
    // Cookie rows must not advertise DB UUID actions (edit/remove/add key).
    canManage: false,
    canRemove: false,
    keys: org.apiKeys.map((key) => ({
      id: key.id,
      label: key.label,
      keyKind: key.keyKind,
      fingerprint: key.fingerprint,
      hint: key.hint,
      identityLabel: key.identityLabel,
      lastValidatedAt: null,
      canEdit: false,
      canRemove: false,
    })),
    source: org.source,
  };
}

export async function listCursorOrganisationViews(): Promise<
  CursorOrganisationView[]
> {
  const user = await currentUser();
  if (user) {
    // Fail closed: session/DB errors must not fall through to cookie.
    const session = await requireSession();
    const dbViews = await listDbOrganisationViews(session.ctx);
    if (dbViews.length > 0) {
      return dbViews.map(viewFromDb);
    }
  }

  const orgs = await readCursorOrganisations();
  return orgs.map(viewFromCookie);
}

export async function actionUpsertCursorOrganisation(
  formData: FormData,
): Promise<UpsertOrganisationResult> {
  const session = await requireSession();
  const idRaw = String(formData.get('id') ?? '').trim();
  const label = String(formData.get('label') ?? '').trim();
  const orgApiKeyRaw = String(formData.get('orgApiKey') ?? '').trim();
  const organizationIdRaw = String(formData.get('organizationId') ?? '').trim();
  const baseUrlResult = normalizeBaseUrl(String(formData.get('baseUrl') ?? ''));
  if (!baseUrlResult.ok) {
    return { ok: false, error: baseUrlResult.error.message };
  }
  const baseUrl = baseUrlResult.value;
  const clearOrgApiKey = String(formData.get('clearOrgApiKey') ?? '') === '1';
  // Optional: seed the first team key while creating the organisation.
  const apiKeyRaw = String(formData.get('apiKey') ?? '').trim();
  const keyLabel = String(formData.get('keyLabel') ?? '').trim();
  const keyKind = parseKeyKind(String(formData.get('keyKind') ?? 'user'));

  if (!label) {
    return { ok: false, error: 'Enter a name for this organisation connection.' };
  }

  let organizationId = normalizeOrganizationId(organizationIdRaw);
  let discoveryNote: string | null = null;
  let cost: OrganisationCostProbe | null = null;
  let orgApiKey: string | null | undefined;

  if (clearOrgApiKey) {
    orgApiKey = null;
  } else if (orgApiKeyRaw.length >= 20) {
    orgApiKey = orgApiKeyRaw;
  } else {
    orgApiKey = undefined;
  }

  const discoveryKey = orgApiKey ?? (apiKeyRaw.length >= 20 ? apiKeyRaw : null);
  if (!organizationId && discoveryKey) {
    const discovered = await discoverOrganizationId({
      apiKey: discoveryKey,
      baseUrl,
    });
    organizationId = discovered.organizationId;
    discoveryNote = discovered.note;
  }

  if (orgApiKey) {
    if (!organizationId) {
      return {
        ok: false,
        error:
          discoveryNote ??
          'Organisation API key requires an organisation id (org_…). Paste it from the Cursor dashboard URL — usage-scoped keys cannot discover it automatically.',
      };
    }

    cost = await probeOrganisationCost({
      orgApiKey,
      organizationId,
      baseUrl,
    });

    if (!cost.pooledUsageOk && !cost.usageEventsOk) {
      return {
        ok: false,
        error:
          cost.note ??
          'Organisation API key could not fetch cost (pooled-usage / filtered-usage-events). Check the key has usage:* (or admin:*) scope and the org id matches.',
      };
    }

    discoveryNote = cost.note
      ? `Organisation cost verified · ${cost.note}`
      : 'Organisation cost verified via Organization API.';
  } else if (organizationId && discoveryKey) {
    try {
      const orgClient = createCursorOrgClient({
        apiKey: discoveryKey,
        baseUrl,
        maxRetries: 0,
      });
      await orgClient.pooledUsage(organizationId);
      discoveryNote =
        'Organisation id verified. Attach User / Team API keys below so Monitoring can list agents.';
    } catch {
      discoveryNote =
        'Saved organisation id. Attach User / Team API keys to list agents; add an Organisation API key (usage:*) for cost.';
    }
  }

  let me: ApiKeyInfo | null = null;
  if (apiKeyRaw.length >= 20) {
    try {
      const client = createCursorClient({
        apiKey: apiKeyRaw,
        baseUrl,
        maxRetries: 1,
      });
      me = await client.getMe();
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? `API key rejected by Cursor (/v1/me): ${err.message}`
            : 'API key rejected by Cursor (/v1/me).',
      };
    }
  }

  const creatingNew = !idRaw;
  const saved = await upsertCursorOrganisation(session.ctx, {
    id: idRaw || null,
    label,
    organizationId,
    baseUrl,
    orgApiKey,
  });
  if (!saved.ok) {
    return { ok: false, error: saved.error.message };
  }

  let teamKeySaved = false;
  if (apiKeyRaw.length >= 20) {
    const added = await addCursorOrganisationApiKey(session.ctx, {
      cursorOrganisationId: saved.value.id,
      label:
        keyLabel ||
        (me
          ? formatApiKeyIdentity(me)
          : keyKind === 'service_account'
            ? 'Team API key'
            : 'User API key'),
      keyKind,
      apiKey: apiKeyRaw,
      identityLabel: me ? formatApiKeyIdentity(me) : null,
    });
    if (!added.ok) {
      if (creatingNew) {
        const rolledBack = await deleteCursorOrganisation(
          session.ctx,
          saved.value.id,
        );
        if (!rolledBack.ok) {
          return {
            ok: false,
            error:
              'The API key was not attached and the new organisation could not be rolled back. Remove the incomplete connection before retrying.',
          };
        }
      }
      return { ok: false, error: added.error.message };
    }
    teamKeySaved = true;
  }

  // Drop legacy cookies only after a team key was durably saved.
  if (teamKeySaved) {
    await clearCursorOrganisations();
  }
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');

  return {
    ok: true,
    id: saved.value.id,
    organizationId: saved.value.organizationId,
    discoveryNote,
    identity: me ? formatApiKeyIdentity(me) : null,
    cost,
  };
}

export async function actionAddCursorOrganisationApiKey(
  formData: FormData,
): Promise<AddApiKeyResult> {
  const session = await requireSession();
  const organisationId = String(formData.get('organisationId') ?? '').trim();
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const label = String(formData.get('label') ?? '').trim();
  const keyKind = parseKeyKind(String(formData.get('keyKind') ?? 'user'));

  if (!organisationId) {
    return { ok: false, error: 'Missing organisation id.' };
  }
  if (apiKey.length < 20) {
    return {
      ok: false,
      error: 'Paste a Cursor User or Team API key (at least 20 characters).',
    };
  }

  const orgs = await listDbOrganisationViews(session.ctx);
  const org = orgs.find((row) => row.id === organisationId);
  if (!org) {
    return { ok: false, error: 'Organisation not found.' };
  }

  let me: ApiKeyInfo | null = null;
  try {
    const client = createCursorClient({
      apiKey,
      baseUrl: org.baseUrl,
      maxRetries: 1,
    });
    me = await client.getMe();
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `API key rejected by Cursor (/v1/me): ${err.message}`
          : 'API key rejected by Cursor (/v1/me).',
    };
  }

  const added = await addCursorOrganisationApiKey(session.ctx, {
    cursorOrganisationId: organisationId,
    label:
      label ||
      (me
        ? formatApiKeyIdentity(me)
        : keyKind === 'service_account'
          ? 'Team API key'
          : 'User API key'),
    keyKind,
    apiKey,
    identityLabel: me ? formatApiKeyIdentity(me) : null,
  });
  if (!added.ok) {
    return { ok: false, error: added.error.message };
  }

  await clearCursorOrganisations();
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');

  return {
    ok: true,
    id: added.value.id,
    identity: me ? formatApiKeyIdentity(me) : null,
    keyKind,
  };
}

/**
 * Immediate, non-mutating check for a User / Team API key via GET /v1/me.
 */
export async function actionValidateUserTeamApiKey(
  formData: FormData,
): Promise<ValidateApiKeyResult> {
  const session = await requireSession();
  const rateLimit = await checkRateLimit(
    `cursor-key-validate-user:${session.userId}`,
    30,
  );
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: `Too many validation attempts. Try again in ${rateLimit.retryAfterSec} seconds.`,
    };
  }

  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const baseUrlResult = normalizeBaseUrl(String(formData.get('baseUrl') ?? ''));
  if (!baseUrlResult.ok) {
    return { ok: false, error: baseUrlResult.error.message };
  }
  if (apiKey.length < 20) {
    return {
      ok: false,
      error: 'Paste a Cursor User or Team API key (at least 20 characters).',
    };
  }

  try {
    const client = createCursorClient({
      apiKey,
      baseUrl: baseUrlResult.value,
      maxRetries: 0,
    });
    const me = await client.getMe();
    const identity = formatApiKeyIdentity(me);
    return {
      ok: true,
      kind: 'user_team',
      identity,
      note: `Valid User / Team API key · ${identity}`,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Key rejected by Cursor (/v1/me): ${err.message}`
          : 'Key rejected by Cursor (/v1/me).',
    };
  }
}

/**
 * Immediate, non-mutating check for an Organisation API key.
 * Uses members listing (no org id required) and optionally pooled-usage when
 * an organisation id is provided.
 */
export async function actionValidateOrganisationApiKey(
  formData: FormData,
): Promise<ValidateApiKeyResult> {
  const session = await requireSession();
  const rateLimit = await checkRateLimit(
    `cursor-key-validate-org:${session.userId}`,
    30,
  );
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: `Too many validation attempts. Try again in ${rateLimit.retryAfterSec} seconds.`,
    };
  }

  const orgApiKey = String(formData.get('orgApiKey') ?? '').trim();
  const organizationId = normalizeOrganizationId(
    String(formData.get('organizationId') ?? ''),
  );
  const baseUrlResult = normalizeBaseUrl(String(formData.get('baseUrl') ?? ''));
  if (!baseUrlResult.ok) {
    return { ok: false, error: baseUrlResult.error.message };
  }
  if (orgApiKey.length < 20) {
    return {
      ok: false,
      error: 'Paste an Organisation API key (at least 20 characters).',
    };
  }

  const orgClient = createCursorOrgClient({
    apiKey: orgApiKey,
    baseUrl: baseUrlResult.value,
    maxRetries: 0,
  });

  const notes: string[] = [];
  let authenticated = false;

  try {
    await orgClient.listMembers({ page: 1, pageSize: 1 });
    authenticated = true;
    notes.push('members endpoint accepted the key');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // usage-scoped keys may reject members.read but still be valid for cost.
    if (/organization\.(members|groups)\.read|usage:\*/i.test(message)) {
      notes.push('key authenticates (usage-scoped; members.read unavailable)');
      authenticated = true;
    } else if (/401|invalid|unauthorized|forbidden/i.test(message)) {
      return {
        ok: false,
        error: `Organisation API key rejected: ${message}`,
      };
    } else {
      notes.push(`members probe: ${message}`);
    }
  }

  if (organizationId) {
    try {
      const pooled = await orgClient.pooledUsage(organizationId);
      authenticated = true;
      const used =
        typeof pooled.pool?.usedCents === 'number'
          ? ` · pooled usage ${(pooled.pool.usedCents / 100).toFixed(2)} used`
          : '';
      notes.push(`pooled-usage ok for ${organizationId}${used}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!authenticated) {
        return {
          ok: false,
          error: `Organisation API key rejected (pooled-usage): ${message}`,
        };
      }
      notes.push(`pooled-usage failed: ${message}`);
    }
  }

  if (!authenticated) {
    return {
      ok: false,
      error:
        notes.join(' · ') ||
        'Organisation API key could not be verified. Check the key and try again.',
    };
  }

  return {
    ok: true,
    kind: 'organisation',
    identity: null,
    note: `Valid Organisation API key · ${notes.join(' · ')}`,
  };
}

export async function actionUpdateCursorOrganisationApiKey(
  formData: FormData,
): Promise<UpdateApiKeyResult> {
  const session = await requireSession();
  const apiKeyId = String(formData.get('apiKeyId') ?? '').trim();
  const label = String(formData.get('label') ?? '').trim();
  const keyKind = parseKeyKind(String(formData.get('keyKind') ?? 'user'));
  const apiKeyRaw = String(formData.get('apiKey') ?? '').trim();

  if (!apiKeyId) {
    return { ok: false, error: 'Missing API key id.' };
  }
  if (!label) {
    return { ok: false, error: 'Enter a name for this API key.' };
  }

  const views = await listDbOrganisationViews(session.ctx);
  const existingKey = views
    .flatMap((org) => org.keys.map((key) => ({ org, key })))
    .find((row) => row.key.id === apiKeyId);
  if (!existingKey) {
    return { ok: false, error: 'API key not found.' };
  }

  let me: ApiKeyInfo | null = null;
  if (apiKeyRaw.length >= 20) {
    try {
      const client = createCursorClient({
        apiKey: apiKeyRaw,
        baseUrl: existingKey.org.baseUrl,
        maxRetries: 1,
      });
      me = await client.getMe();
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? `API key rejected by Cursor (/v1/me): ${err.message}`
            : 'API key rejected by Cursor (/v1/me).',
      };
    }
  } else if (apiKeyRaw.length > 0) {
    return {
      ok: false,
      error: 'Paste a Cursor User or Team API key (at least 20 characters).',
    };
  }

  const updated = await updateCursorOrganisationApiKey(session.ctx, {
    apiKeyId,
    label,
    keyKind,
    apiKey: apiKeyRaw.length >= 20 ? apiKeyRaw : undefined,
    identityLabel: me ? formatApiKeyIdentity(me) : undefined,
    markValidated: Boolean(me),
  });
  if (!updated.ok) {
    return { ok: false, error: updated.error.message };
  }

  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');

  return {
    ok: true,
    id: updated.value.id,
    identity: updated.value.identityLabel,
    keyKind: updated.value.keyKind,
    label: updated.value.label,
  };
}

export async function actionRemoveCursorOrganisationApiKey(
  apiKeyId: string,
): Promise<OrganisationMutationResult> {
  const session = await requireSession();

  const revoked = await revokeCursorOrganisationApiKey(session.ctx, apiKeyId);
  if (!revoked.ok) {
    return { ok: false, error: revoked.error.message };
  }

  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');
  return { ok: true };
}

export async function actionRemoveCursorOrganisation(
  id: string,
): Promise<OrganisationMutationResult> {
  const session = await requireSession();

  const deleted = await deleteCursorOrganisation(session.ctx, id);
  if (!deleted.ok) {
    return { ok: false, error: deleted.error.message };
  }

  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');
  return { ok: true };
}

export async function actionRemoveAllCursorOrganisations(): Promise<OrganisationMutationResult> {
  const session = await requireSession();

  const deleted = await deleteAllCursorOrganisations(session.ctx);
  if (!deleted.ok) {
    return { ok: false, error: deleted.error.message };
  }

  // Legacy cookie only — DB rows owned by other members must remain.
  await clearCursorOrganisations();
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');
  return { ok: true };
}

export async function actionDiscoverOrganizationId(
  formData: FormData,
): Promise<
  | {
      ok: true;
      organizationId: string | null;
      note: string | null;
    }
  | { ok: false; error: string }
> {
  const session = await requireSession();
  const rateLimit = await checkRateLimit(
    `cursor-org-discovery:${session.userId}`,
    10,
  );
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: `Too many lookup attempts. Try again in ${rateLimit.retryAfterSec} seconds.`,
    };
  }
  const apiKey = String(
    formData.get('orgApiKey') || formData.get('apiKey') || '',
  ).trim();
  const baseUrlResult = normalizeBaseUrl(String(formData.get('baseUrl') ?? ''));
  if (!baseUrlResult.ok) {
    return { ok: false, error: baseUrlResult.error.message };
  }
  const baseUrl = baseUrlResult.value;
  if (apiKey.length < 20) {
    return {
      ok: false,
      error:
        'Paste an Organisation API key (or User / Team API key) to look up the org id.',
    };
  }
  const result = await discoverOrganizationId({ apiKey, baseUrl });
  return {
    ok: true,
    organizationId: result.organizationId,
    note: result.note,
  };
}
