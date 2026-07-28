import type { CostSource } from '@nexus/db';
import { mergeCostSource } from './rollups';

/** Merge item-level spend sources into one project-level label. */
export function aggregateSpendSource(
  sources: Array<string | null | undefined>,
): CostSource | null {
  let acc: CostSource | null = null;
  for (const raw of sources) {
    if (!raw) continue;
    const s = raw as CostSource;
    acc = acc ? mergeCostSource(acc, s) : s;
  }
  return acc;
}
