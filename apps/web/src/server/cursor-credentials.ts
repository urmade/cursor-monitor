'use server';

import { revalidatePath } from 'next/cache';
import {
  actionRemoveAllCursorOrganisations,
  actionRemoveCursorOrganisation,
} from './cursor-organisations';
import { readCursorOrganisations } from './cursor-org-store';
import { credentialFingerprint } from './cursor';

export type ConnectCursorKeyResult =
  | { ok: true; identity: string; keyCount: number }
  | { ok: false; error: string };

export type ConnectedCursorKeyView = {
  fingerprint: string;
  identity: string;
};

/**
 * @deprecated Prefer actionUpsertCursorOrganisation on the Settings page.
 * Cookie-based key storage is no longer supported — never persists supplied keys.
 */
export async function actionConnectCursorApiKey(
  _formData: FormData,
): Promise<ConnectCursorKeyResult> {
  return {
    ok: false,
    error:
      'Connect organisations from Settings → Organisations. Cookie-based API key storage is no longer supported.',
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
