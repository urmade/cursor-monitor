'use server';

import { revalidatePath } from 'next/cache';
import { createCursorClient } from '@nexus/cursor-client';
import {
  clearUserCursorApiKey,
  writeUserCursorApiKey,
} from './cursor';

export type ConnectCursorKeyResult =
  | { ok: true; identity: string }
  | { ok: false; error: string };

export async function actionConnectCursorApiKey(
  formData: FormData,
): Promise<ConnectCursorKeyResult> {
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  if (!apiKey) {
    return { ok: false, error: 'Paste a Cursor API key.' };
  }
  if (apiKey.length < 20) {
    return { ok: false, error: 'That does not look like a Cursor API key.' };
  }

  try {
    const client = createCursorClient({ apiKey });
    const me = await client.getMe();
    await writeUserCursorApiKey(apiKey);
    revalidatePath('/monitoring');
    const identityParts = [
      me.userEmail,
      me.apiKeyName,
      me.userId != null ? `userId=${me.userId}` : null,
    ].filter(Boolean);
    return {
      ok: true,
      identity: identityParts.join(' · ') || me.apiKeyName || 'connected',
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Key rejected by Cursor (/v1/me): ${err.message}`
          : 'Key rejected by Cursor (/v1/me)',
    };
  }
}

export async function actionDisconnectCursorApiKey(): Promise<void> {
  await clearUserCursorApiKey();
  revalidatePath('/monitoring');
}
