'use server';

import { revalidatePath } from 'next/cache';
import { createCursorClient, defaultCursorApiBaseUrl } from '@nexus/cursor-client';
import { formatApiKeyIdentity } from './cursor';
import {
  actionRemoveAllCursorOrganisations,
  actionRemoveCursorOrganisation,
} from './cursor-organisations';
import {
  readCursorOrganisations,
  writeCursorOrganisations,
  type StoredCursorOrganisation,
} from './cursor-org-store';
import {
  credentialFingerprint,
  invalidateMonitoringCache,
} from './monitoring-cache';

export type ConnectCursorKeyResult =
  | { ok: true; identity: string; keyCount: number }
  | { ok: false; error: string };

export type ConnectedCursorKeyView = {
  fingerprint: string;
  identity: string;
};

function parseKeysFromForm(formData: FormData): string[] {
  const raw = String(formData.get('apiKey') ?? formData.get('apiKeys') ?? '');
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    ),
  ];
}

/** @deprecated Prefer actionUpsertCursorOrganisation on the Settings page. */
export async function actionConnectCursorApiKey(
  formData: FormData,
): Promise<ConnectCursorKeyResult> {
  const incoming = parseKeysFromForm(formData);
  if (incoming.length === 0) {
    return {
      ok: false,
      error: 'Paste one or more Cursor API keys (one per line).',
    };
  }

  const existing = await readCursorOrganisations();
  const existingFingerprints = new Set(
    existing.map((row) => credentialFingerprint(row.apiKey)),
  );
  const accepted: StoredCursorOrganisation[] = [...existing];
  const identities: string[] = [];
  const errors: string[] = [];

  for (const apiKey of incoming) {
    if (apiKey.length < 20) {
      errors.push('Skipped a value that does not look like a Cursor API key.');
      continue;
    }
    const fp = credentialFingerprint(apiKey);
    if (existingFingerprints.has(fp)) {
      errors.push('That key is already connected.');
      continue;
    }
    try {
      const client = createCursorClient({ apiKey });
      const me = await client.getMe();
      accepted.push({
        id: fp,
        label:
          accepted.length === 0
            ? 'Connected organisation'
            : `Organisation ${accepted.length + 1}`,
        organizationId: null,
        apiKey,
        orgApiKey: null,
        baseUrl: defaultCursorApiBaseUrl(),
      });
      existingFingerprints.add(fp);
      identities.push(formatApiKeyIdentity(me));
      await invalidateMonitoringCache(fp);
    } catch (err) {
      errors.push(
        err instanceof Error
          ? `Key rejected by Cursor (/v1/me): ${err.message}`
          : 'Key rejected by Cursor (/v1/me)',
      );
    }
  }

  if (identities.length === 0) {
    return {
      ok: false,
      error: errors[0] ?? 'No API keys were connected.',
    };
  }

  await writeCursorOrganisations(accepted);
  revalidatePath('/monitoring');
  revalidatePath('/settings/organisations');
  return {
    ok: true,
    identity: identities.join(' · '),
    keyCount: accepted.length,
  };
}

/** @deprecated Prefer actionRemoveCursorOrganisation. */
export async function actionDisconnectCursorApiKey(
  fingerprint?: string,
): Promise<void> {
  if (!fingerprint) {
    await actionRemoveAllCursorOrganisations();
    return;
  }
  const existing = await readCursorOrganisations();
  const target = existing.find(
    (row) => credentialFingerprint(row.apiKey) === fingerprint,
  );
  if (target) {
    await actionRemoveCursorOrganisation(target.id);
    return;
  }
  revalidatePath('/monitoring');
}

/** @deprecated Prefer actionRemoveAllCursorOrganisations. */
export async function actionDisconnectAllCursorApiKeys(): Promise<void> {
  await actionRemoveAllCursorOrganisations();
}
