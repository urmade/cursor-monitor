'use server';

import { revalidatePath } from 'next/cache';
import { createCursorClient } from '@nexus/cursor-client';
import {
  clearUserCursorApiKey,
  formatApiKeyIdentity,
  readUserCursorApiKeys,
  writeUserCursorApiKeys,
} from './cursor';
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

  const existing = await readUserCursorApiKeys();
  const existingFingerprints = new Set(
    existing.map((k) => credentialFingerprint(k)),
  );
  const accepted: string[] = [...existing];
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
      accepted.push(apiKey);
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

  await writeUserCursorApiKeys(accepted);
  revalidatePath('/monitoring');
  return {
    ok: true,
    identity: identities.join(' · '),
    keyCount: accepted.length,
  };
}

export async function actionDisconnectCursorApiKey(
  fingerprint?: string,
): Promise<void> {
  if (!fingerprint) {
    await clearUserCursorApiKey();
    revalidatePath('/monitoring');
    return;
  }
  const existing = await readUserCursorApiKeys();
  const remaining = existing.filter(
    (key) => credentialFingerprint(key) !== fingerprint,
  );
  await writeUserCursorApiKeys(remaining);
  await invalidateMonitoringCache(fingerprint);
  revalidatePath('/monitoring');
}

export async function actionDisconnectAllCursorApiKeys(): Promise<void> {
  const existing = await readUserCursorApiKeys();
  for (const key of existing) {
    await invalidateMonitoringCache(credentialFingerprint(key));
  }
  await clearUserCursorApiKey();
  revalidatePath('/monitoring');
}
