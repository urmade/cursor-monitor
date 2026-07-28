/** 1 USD = 1_000_000 micro-USD (integer minor units at 1e-6 USD). */
export type MicroUsd = bigint;

export const MICRO_PER_USD = BigInt(1_000_000);
export const MICRO_PER_CENT = BigInt(10_000);
const ZERO = BigInt(0);
const HALF_CENT = BigInt(5_000);
const TEN_THOUSAND = BigInt(10_000);
const ONE_THOUSAND = BigInt(1_000);
const HALF_TOKEN_UNIT = BigInt(500);

export function fromCents(cents: number): MicroUsd {
  if (!Number.isFinite(cents)) return ZERO;
  return BigInt(Math.round(cents * Number(MICRO_PER_CENT)));
}

export function fromUsd(usd: number): MicroUsd {
  if (!Number.isFinite(usd)) return ZERO;
  return BigInt(Math.round(usd * Number(MICRO_PER_USD)));
}

export function toUsd(m: MicroUsd): number {
  return Number(m) / Number(MICRO_PER_USD);
}

export type DisplayOpts = {
  subCent?: boolean;
  currency?: 'USD';
};

export function toDisplay(m: MicroUsd, opts: DisplayOpts = {}): string {
  const subCent = opts.subCent !== false;
  if (m === ZERO) return '$0.00';
  const negative = m < ZERO;
  const abs = negative ? -m : m;
  const cents = (abs + HALF_CENT) / TEN_THOUSAND;
  if (cents === ZERO && subCent && abs > ZERO) {
    return negative ? '<-$0.01' : '<$0.01';
  }
  const dollars = Number(cents) / 100;
  const formatted = dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: opts.currency ?? 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return negative ? `-${formatted}` : formatted;
}

export function tokenBucketMicro(
  tokens: number,
  microPer1k: MicroUsd,
): MicroUsd {
  if (tokens <= 0 || microPer1k === ZERO) return ZERO;
  const num = BigInt(tokens) * microPer1k;
  return (num + HALF_TOKEN_UNIT) / ONE_THOUSAND;
}

export function applySurchargeBps(base: MicroUsd, surchargeBps: number): MicroUsd {
  if (surchargeBps <= 0) return base;
  const mult = TEN_THOUSAND + BigInt(surchargeBps);
  return (base * mult + HALF_CENT) / TEN_THOUSAND;
}
