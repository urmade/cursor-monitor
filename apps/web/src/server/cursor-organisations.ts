'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  createCursorClient,
  createCursorOrgClient,
  discoverOrganizationId,
  normalizeOrganizationId,
  type ApiKeyInfo,
} from '@nexus/cursor-client';
import { formatApiKeyIdentity } from './cursor';
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

export type UpsertOrganisationResult =
  | {
      ok: true;
      id: string;
      organizationId: string | null;
      discoveryNote: string | null;
      identity: string | null;
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

  if (!organizationId) {
    const discovered = await discoverOrganizationId({
      apiKey: discoveryKey,
      baseUrl,
    });
    organizationId = discovered.organizationId;
    discoveryNote = discovered.note;
  } else {
    try {
      const orgClient = createCursorOrgClient({
        apiKey: discoveryKey,
        baseUrl,
        maxRetries: 0,
      });
      await orgClient.pooledUsage(organizationId);
      discoveryNote = 'Organisation id verified via Organization API.';
    } catch {
      discoveryNote =
        'Saved organisation id as entered (could not verify via Organization API with this key).';
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
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');

  return {
    ok: true,
    id,
    organizationId,
    discoveryNote,
    identity: me ? formatApiKeyIdentity(me) : null,
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
  revalidatePath('/settings/organisations');
  revalidatePath('/monitoring');
}

export async function actionRemoveAllCursorOrganisations(): Promise<void> {
  const existing = await readCursorOrganisations();
  for (const org of existing) {
    await invalidateMonitoringCache(fingerprintApiKey(org.apiKey));
  }
  await clearCursorOrganisations();
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
