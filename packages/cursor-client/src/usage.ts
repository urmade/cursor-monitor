import type { AgentUsage, AgentUsageRun } from './types';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Accepts both the flat fixture shape and the live nested
 * `{ totalUsage, cost, runs[] }` response from GET /v1/agents/{id}/usage.
 */
export function normalizeAgentUsage(raw: unknown): AgentUsage {
  const body = asRecord(raw) ?? {};
  const totalUsage = asRecord(body.totalUsage);
  const cost = asRecord(body.cost);
  const runsRaw = Array.isArray(body.runs) ? body.runs : undefined;

  const runs: AgentUsageRun[] | undefined = runsRaw?.map((entry) => {
    const row = asRecord(entry) ?? {};
    const usage = asRecord(row.usage);
    const runCost = asRecord(row.cost);
    return {
      ...row,
      id: asString(row.id) ?? '',
      usageUuid: asString(row.usageUuid),
      usage: usage
        ? {
            inputTokens: asNumber(usage.inputTokens),
            outputTokens: asNumber(usage.outputTokens),
            cacheWriteTokens: asNumber(usage.cacheWriteTokens),
            cacheReadTokens: asNumber(usage.cacheReadTokens),
            totalTokens: asNumber(usage.totalTokens),
          }
        : undefined,
      cost: runCost
        ? {
            rawCostCents: asNumber(runCost.rawCostCents),
            chargedCents: asNumber(runCost.chargedCents),
          }
        : undefined,
    };
  });

  const firstRun = runs?.[0];
  const inputTokens =
    asNumber(body.inputTokens) ??
    asNumber(totalUsage?.inputTokens) ??
    firstRun?.usage?.inputTokens;
  const outputTokens =
    asNumber(body.outputTokens) ??
    asNumber(totalUsage?.outputTokens) ??
    firstRun?.usage?.outputTokens;
  const cacheWriteTokens =
    asNumber(body.cacheWriteTokens) ??
    asNumber(totalUsage?.cacheWriteTokens) ??
    firstRun?.usage?.cacheWriteTokens;
  const cacheReadTokens =
    asNumber(body.cacheReadTokens) ??
    asNumber(totalUsage?.cacheReadTokens) ??
    firstRun?.usage?.cacheReadTokens;
  const totalTokens =
    asNumber(body.totalTokens) ??
    asNumber(totalUsage?.totalTokens) ??
    firstRun?.usage?.totalTokens;
  const chargedCents =
    asNumber(body.chargedCents) ??
    asNumber(cost?.chargedCents) ??
    firstRun?.cost?.chargedCents;
  const rawCostCents =
    asNumber(body.rawCostCents) ??
    asNumber(cost?.rawCostCents) ??
    firstRun?.cost?.rawCostCents;
  const usageUuid = asString(body.usageUuid) ?? firstRun?.usageUuid;

  return {
    ...body,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    totalTokens,
    usageUuid,
    chargedCents,
    rawCostCents,
    totalUsage: totalUsage
      ? {
          inputTokens: asNumber(totalUsage.inputTokens),
          outputTokens: asNumber(totalUsage.outputTokens),
          cacheWriteTokens: asNumber(totalUsage.cacheWriteTokens),
          cacheReadTokens: asNumber(totalUsage.cacheReadTokens),
          totalTokens: asNumber(totalUsage.totalTokens),
        }
      : undefined,
    cost:
      cost || chargedCents !== undefined || rawCostCents !== undefined
        ? {
            chargedCents,
            rawCostCents,
          }
        : undefined,
    runs,
  };
}
