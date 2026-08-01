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
  upsertCursorOrganisation,
  type CursorApiKeyKind,
  type CursorOrganisationView as DbOrganisationView,
} from '@nexus/core';
import {
  combinedCredentialFingerprint,
  formatApiKeyIdentity,
} from './cursor';
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
import { invalidateMonitoringCache } from './monitoring-cache';
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

export type OrganisationMutationResult =
  | { ok: true }
  | { ok: false; error: string };

async function invalidateFingerprints(fingerprints: string[]): Promise<void> {
  for (const fingerprint of new Set(fingerprints.filter(Boolean))) {
    await invalidateMonitoringCache(fingerprint);
  }
}

function activeFingerprints(views: DbOrganisationView[]): string[] {
  return views.flatMap((org) => org.keys.map((key) => key.fingerprint));
}

async function invalidateCredentialSets(
  fingerprintSets: string[][],
  changedFingerprints: string[] = [],
): Promise<void> {
  await invalidateFingerprints([
    ...changedFingerprints,
    ...fingerprintSets.map(combinedCredentialFingerprint),
  ]);
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
  const keyKindRaw = String(formData.get('keyKind') ?? 'user').trim();
  const keyKind: CursorApiKeyKind =
    keyKindRaw === 'service_account' ? 'service_account' : 'user';

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
        'Organisation id verified. Attach user / service-account keys below so Monitoring can list Cloud Agents.';
    } catch {
      discoveryNote =
        'Saved organisation id. Attach user / service-account API keys to list Cloud Agents; add an Organisation API key (usage:*) for cost.';
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
        (me ? formatApiKeyIdentity(me) : keyKind === 'service_account'
          ? 'Service account'
          : 'Team API key'),
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
    const currentViews = await listDbOrganisationViews(session.ctx);
    await invalidateCredentialSets(
      [activeFingerprints(currentViews)],
      [added.value.fingerprint],
    );
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
  const keyKindRaw = String(formData.get('keyKind') ?? 'user').trim();
  const keyKind: CursorApiKeyKind =
    keyKindRaw === 'service_account' ? 'service_account' : 'user';

  if (!organisationId) {
    return { ok: false, error: 'Missing organisation id.' };
  }
  if (apiKey.length < 20) {
    return {
      ok: false,
      error: 'Paste a Cursor API key (Cloud Agents / user / service account).',
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
    label: label || (me ? formatApiKeyIdentity(me) : 'Team API key'),
    keyKind,
    apiKey,
    identityLabel: me ? formatApiKeyIdentity(me) : null,
  });
  if (!added.ok) {
    return { ok: false, error: added.error.message };
  }

  const previousFingerprints = activeFingerprints(orgs);
  await invalidateCredentialSets(
    [
      previousFingerprints,
      [...previousFingerprints, added.value.fingerprint],
    ],
    [added.value.fingerprint],
  );
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

export async function actionRemoveCursorOrganisationApiKey(
  apiKeyId: string,
): Promise<OrganisationMutationResult> {
  const session = await requireSession();
  const views = await listDbOrganisationViews(session.ctx);
  const previousFingerprints = activeFingerprints(views);
  const fingerprint =
    views.flatMap((org) => org.keys).find((key) => key.id === apiKeyId)
      ?.fingerprint ?? null;

  const revoked = await revokeCursorOrganisationApiKey(session.ctx, apiKeyId);
  if (!revoked.ok) {
    return { ok: false, error: revoked.error.message };
  }

  await invalidateCredentialSets(
    [
      previousFingerprints,
      previousFingerprints.filter((value) => value !== fingerprint),
    ],
    fingerprint ? [fingerprint] : [],
  );
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');
  return { ok: true };
}

export async function actionRemoveCursorOrganisation(
  id: string,
): Promise<OrganisationMutationResult> {
  const session = await requireSession();
  const existing = await listDbOrganisationViews(session.ctx);
  const previousFingerprints = activeFingerprints(existing);
  const target = existing.find((row) => row.id === id);

  const deleted = await deleteCursorOrganisation(session.ctx, id);
  if (!deleted.ok) {
    return { ok: false, error: deleted.error.message };
  }

  const removedFingerprints =
    target?.keys.map((key) => key.fingerprint) ?? [];
  await invalidateCredentialSets(
    [
      previousFingerprints,
      previousFingerprints.filter(
        (fingerprint) => !removedFingerprints.includes(fingerprint),
      ),
    ],
    removedFingerprints,
  );
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');
  return { ok: true };
}

export async function actionRemoveAllCursorOrganisations(): Promise<OrganisationMutationResult> {
  const session = await requireSession();
  const existing = await listDbOrganisationViews(session.ctx);
  const previousFingerprints = activeFingerprints(existing);
  const owned = existing.filter((org) => org.canRemove);

  const deleted = await deleteAllCursorOrganisations(session.ctx);
  if (!deleted.ok) {
    return { ok: false, error: deleted.error.message };
  }

  const removedFingerprints = owned.flatMap((org) =>
    org.keys.map((key) => key.fingerprint),
  );
  await invalidateCredentialSets(
    [
      previousFingerprints,
      previousFingerprints.filter(
        (fingerprint) => !removedFingerprints.includes(fingerprint),
      ),
    ],
    removedFingerprints,
  );
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
        'Paste an Organization API key (or Cloud Agents key) to look up the org id.',
    };
  }
  const result = await discoverOrganizationId({ apiKey, baseUrl });
  return {
    ok: true,
    organizationId: result.organizationId,
    note: result.note,
  };
}
