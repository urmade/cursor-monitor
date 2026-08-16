'use server';

import { revalidatePath } from 'next/cache';
import {
  checkRateLimit,
  reconcileStopHookUsageCostsFromFirstHook,
  type HookCostBackfillSummary,
} from '@nexus/core';
import { requireSession } from './session';

export type BackfillHookCostsResult =
  | { ok: true; summary: HookCostBackfillSummary }
  | { ok: false; error: string };

/**
 * Fetch every Team usage event from the first recorded stop hook through now
 * and fill actual cost on unpriced hooks. Already-priced rows are left alone.
 */
export async function actionBackfillStopHookCosts(): Promise<BackfillHookCostsResult> {
  const session = await requireSession();
  const rateLimit = await checkRateLimit(
    `cursor-hook-cost-backfill:${session.userId}`,
    1,
  );
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: `Backfill already ran recently. Try again in ${rateLimit.retryAfterSec} seconds.`,
    };
  }

  try {
    const summary = await reconcileStopHookUsageCostsFromFirstHook();
    revalidatePath('/monitoring');
    if (summary.skippedNoTeamKey) {
      return {
        ok: false,
        error:
          summary.message ??
          'Add a Team API key first so Monitoring can read POST /teams/filtered-usage-events.',
      };
    }
    if (summary.message && summary.usageEvents === 0 && summary.upgraded === 0) {
      return { ok: false, error: summary.message };
    }
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 240) };
  }
}
