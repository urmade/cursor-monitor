import { and, desc, eq, lte } from 'drizzle-orm';
import { modelPrices } from '@nexus/db';
import type { Db } from '@nexus/db';
import { applySurchargeBps, tokenBucketMicro, type MicroUsd } from './money';

export type PriceRow = typeof modelPrices.$inferSelect;

export async function lookupPriceRow(
  db: Db,
  model: string | null | undefined,
  at: Date,
): Promise<PriceRow | null> {
  const normalized = (model ?? '').trim() || 'default';
  const rows = await db.query.modelPrices.findMany({
    where: and(
      eq(modelPrices.model, normalized),
      lte(modelPrices.effectiveFrom, at),
    ),
    orderBy: [desc(modelPrices.effectiveFrom)],
    limit: 1,
  });
  if (rows[0]) return rows[0];
  if (normalized === 'default') return null;
  return lookupPriceRow(db, 'default', at);
}

export type TokenVector = {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
};

export function estimateFromPriceRow(
  row: PriceRow,
  tokens: TokenVector,
): MicroUsd {
  let sum = BigInt(0);
  sum += tokenBucketMicro(tokens.input ?? 0, row.inputMicroUsdPer1k);
  sum += tokenBucketMicro(tokens.output ?? 0, row.outputMicroUsdPer1k);
  sum += tokenBucketMicro(tokens.cacheWrite ?? 0, row.cacheWriteMicroUsdPer1k);
  sum += tokenBucketMicro(tokens.cacheRead ?? 0, row.cacheReadMicroUsdPer1k);
  return applySurchargeBps(sum, row.surchargeBps);
}
