import { CursorApiError, mapHttpError } from './errors';
import type { AutomationWebhookPayload } from './types';

export type PostAutomationWebhookOptions = {
  webhookUrl: string;
  automationKey: string;
  payload: AutomationWebhookPayload;
  fetchImpl?: typeof fetch;
};

/**
 * POST to a Cursor automation webhook trigger.
 * Auth: Authorization: Bearer <automation key>
 */
export async function postAutomationWebhook(
  opts: PostAutomationWebhookOptions,
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(opts.webhookUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.automationKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(opts.payload),
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    throw mapHttpError(res.status, parsed);
  }
  return parsed;
}

export { CursorApiError };
