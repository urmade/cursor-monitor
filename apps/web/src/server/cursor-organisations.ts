'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  createCursorAdminClient,
  createCursorClient,
  createCursorOrgClient,
  discoverOrganizationId,
  normalizeOrganizationId,
  type ApiKeyInfo,
} from '@nexus/cursor-client';
import { formatApiKeyIdentity } from './cursor';
import { writeOrgCostCredentialsStore } from './cursor-org-cost-credentials';
import {
  clearCursorOrganisations,
  fingerprintApiKey,
  maskApiKey,
  normalizeBaseUrl,
  readCursorOrganisations,
  writeCursorOrganisations,
  type CursorOrganisationView,
  type StoredCursorOrganisation,
} from './cursor-org-store';
import { invalidateMonitoringCache } from './monitoring-cache';

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

async function probeIdentity(
  apiKey: string,
  baseUrl: string,
): Promise<ApiKeyInfo | null> {
  try {
    const client = createCursorClient({ apiKey, baseUrl, maxRetries: 0 });
    return await client.getMe();
  } catch {
    return null;
  }
}

async function syncOrgCostCredentialsFromStore(): Promise<void> {
  const orgs = await readCursorOrganisations();
  await writeOrgCostCredentialsStore(orgs);
}

/**
 * Verify Organization Admin cost endpoints with the given key + org id.
 * Used when saving Settings → Organisations so cost wiring is proven before persist.
 */
export async function probeOrganisationCost(opts: {
  orgApiKey: string;
  organizationId: string;
  baseUrl: string;
}): Promise<OrganisationCostProbe> {
  const orgClient = createCursorOrgClient({
    apiKey: opts.orgApiKey,
    baseUrl: opts.baseUrl,
    maxRetries: 0,
  });
  const adminClient = createCursorAdminClient({
    apiKey: opts.orgApiKey,
    baseUrl: opts.baseUrl,
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

export async function listCursorOrganisationViews(): Promise<
  CursorOrganisationView[]
> {
  const orgs = await readCursorOrganisations();
  const views: CursorOrganisationView[] = [];
  for (const org of orgs) {
    const me = await probeIdentity(org.apiKey, org.baseUrl);
    views.push({
      id: org.id,
      label: org.label,
      organizationId: org.organizationId,
      baseUrl: org.baseUrl,
      fingerprint: fingerprintApiKey(org.apiKey),
      identity: me ? formatApiKeyIdentity(me) : null,
      hasOrgApiKey: Boolean(org.orgApiKey),
      apiKeyHint: maskApiKey(org.apiKey),
    });
  }
  return views;
}

export async function actionUpsertCursorOrganisation(
  formData: FormData,
): Promise<UpsertOrganisationResult> {
  const idRaw = String(formData.get('id') ?? '').trim();
  const label = String(formData.get('label') ?? '').trim();
  const apiKeyRaw = String(formData.get('apiKey') ?? '').trim();
  const orgApiKeyRaw = String(formData.get('orgApiKey') ?? '').trim();
  const organizationIdRaw = String(formData.get('organizationId') ?? '').trim();
  const baseUrl = normalizeBaseUrl(String(formData.get('baseUrl') ?? ''));
  const clearOrgApiKey = String(formData.get('clearOrgApiKey') ?? '') === '1';

  if (!label) {
    return { ok: false, error: 'Enter a name for this organisation connection.' };
  }

  const existing = await readCursorOrganisations();
  const previous = idRaw ? existing.find((row) => row.id === idRaw) : undefined;
  const apiKey = apiKeyRaw || previous?.apiKey || '';
  if (apiKey.length < 20) {
    return {
      ok: false,
      error: 'Paste a Cursor API key (Cloud Agents / user / service account).',
    };
  }

  let me: ApiKeyInfo | null = null;
  try {
    const client = createCursorClient({ apiKey, baseUrl, maxRetries: 1 });
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

  let orgApiKey: string | null = null;
  if (clearOrgApiKey) {
    orgApiKey = null;
  } else if (orgApiKeyRaw.length >= 20) {
    orgApiKey = orgApiKeyRaw;
  } else if (previous?.orgApiKey) {
    orgApiKey = previous.orgApiKey;
  }

  const discoveryKey = orgApiKey ?? apiKey;

  let organizationId = normalizeOrganizationId(organizationIdRaw);
  let discoveryNote: string | null = null;
  let cost: OrganisationCostProbe | null = null;

  if (!organizationId) {
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
  } else if (organizationId) {
    // Soft-check with Cloud Agents key — usually fails; keep as advisory.
    try {
      const orgClient = createCursorOrgClient({
        apiKey: discoveryKey,
        baseUrl,
        maxRetries: 0,
      });
      await orgClient.pooledUsage(organizationId);
      discoveryNote =
        'Organisation id verified (Cloud Agents key unexpectedly accepted Organization API). Add an Organisation API key for stop-hook cost.';
    } catch {
      discoveryNote =
        'Saved organisation id. Add an Organisation API key (usage:*) to fetch pooled usage and stop-hook cost.';
    }
  }

  const id = idRaw || randomUUID();
  const nextRow: StoredCursorOrganisation = {
    id,
    label,
    organizationId,
    apiKey,
    orgApiKey,
    baseUrl,
  };

  const withoutSelf = existing.filter((row) => row.id !== id);
  const duplicateKey = withoutSelf.find(
    (row) => fingerprintApiKey(row.apiKey) === fingerprintApiKey(apiKey),
  );
  if (duplicateKey) {
    return {
      ok: false,
      error: `That API key is already connected as “${duplicateKey.label}”.`,
    };
  }

  if (previous) {
    await invalidateMonitoringCache(fingerprintApiKey(previous.apiKey));
  }
  await invalidateMonitoringCache(fingerprintApiKey(apiKey));

  await writeCursorOrganisations([...withoutSelf, nextRow]);
  await syncOrgCostCredentialsFromStore();
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');

  return {
    ok: true,
    id,
    organizationId,
    discoveryNote,
    identity: me ? formatApiKeyIdentity(me) : null,
    cost,
  };
}

export async function actionRemoveCursorOrganisation(
  id: string,
): Promise<void> {
  const existing = await readCursorOrganisations();
  const target = existing.find((row) => row.id === id);
  const remaining = existing.filter((row) => row.id !== id);
  if (target) {
    await invalidateMonitoringCache(fingerprintApiKey(target.apiKey));
  }
  await writeCursorOrganisations(remaining);
  await syncOrgCostCredentialsFromStore();
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');
}

export async function actionRemoveAllCursorOrganisations(): Promise<void> {
  const existing = await readCursorOrganisations();
  for (const org of existing) {
    await invalidateMonitoringCache(fingerprintApiKey(org.apiKey));
  }
  await clearCursorOrganisations();
  await writeOrgCostCredentialsStore([]);
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');
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
  const apiKey = String(
    formData.get('orgApiKey') || formData.get('apiKey') || '',
  ).trim();
  const baseUrl = normalizeBaseUrl(String(formData.get('baseUrl') ?? ''));
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
