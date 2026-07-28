import type { Complexity } from '@nexus/contracts';
import {
  ProjectBudgetSettingsSchema,
  type ProjectBudgetSettingsInput,
} from '@nexus/contracts';
import { fromUsd, type MicroUsd } from '../cost/money';

export type ComplexityTier = Complexity;

export type TierBudget = {
  softMicroUsd: MicroUsd;
  hardMicroUsd: MicroUsd;
};

export type ProjectBudgetSettings = {
  complexityDefaults: Record<ComplexityTier, TierBudget>;
  burnCapMicroUsd: MicroUsd | null;
  burnSoftRatio: number;
  blockOnBurnCap: boolean;
  reserveMicroUsdPerRun: MicroUsd;
};

export const DEFAULT_BUDGET_SETTINGS: ProjectBudgetSettings = {
  complexityDefaults: {
    low: { softMicroUsd: fromUsd(2), hardMicroUsd: fromUsd(5) },
    medium: { softMicroUsd: fromUsd(5), hardMicroUsd: fromUsd(15) },
    high: { softMicroUsd: fromUsd(15), hardMicroUsd: fromUsd(50) },
  },
  burnCapMicroUsd: fromUsd(100),
  burnSoftRatio: 0.8,
  blockOnBurnCap: true,
  reserveMicroUsdPerRun: fromUsd(2),
};

function tierFromParsed(
  key: ComplexityTier,
  parsed: ProjectBudgetSettingsInput | null,
): TierBudget {
  const defaults = DEFAULT_BUDGET_SETTINGS.complexityDefaults[key];
  const t = parsed?.complexityDefaults?.[key];
  if (!t) return defaults;
  const soft =
    t.softMicroUsd ??
    (t.softUsd != null ? fromUsd(t.softUsd) : defaults.softMicroUsd);
  const hard =
    t.hardMicroUsd ??
    (t.hardUsd != null ? fromUsd(t.hardUsd) : defaults.hardMicroUsd);
  if (soft == null || hard == null || soft >= hard) return defaults;
  return { softMicroUsd: soft, hardMicroUsd: hard };
}

export function parseProjectBudgetSettings(
  settings: Record<string, unknown> | null | undefined,
): ProjectBudgetSettings {
  const defaults = DEFAULT_BUDGET_SETTINGS;
  const raw = settings?.budget;
  const parsed = ProjectBudgetSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return defaults;
  }
  const v = parsed.data;

  const burnCap =
    v.burnCapMicroUsd ??
    (v.burnCapUsd != null ? fromUsd(v.burnCapUsd) : defaults.burnCapMicroUsd);

  const reserve =
    v.reserveMicroUsdPerRun ??
    (v.reserveUsd != null ? fromUsd(v.reserveUsd) : defaults.reserveMicroUsdPerRun);

  return {
    complexityDefaults: {
      low: tierFromParsed('low', v),
      medium: tierFromParsed('medium', v),
      high: tierFromParsed('high', v),
    },
    burnCapMicroUsd: burnCap,
    burnSoftRatio: v.burnSoftRatio ?? defaults.burnSoftRatio,
    blockOnBurnCap: v.blockOnBurnCap ?? defaults.blockOnBurnCap,
    reserveMicroUsdPerRun: reserve ?? defaults.reserveMicroUsdPerRun,
  };
}

export function hardBudgetForComplexity(
  settings: ProjectBudgetSettings,
  complexity: ComplexityTier | null | undefined,
): MicroUsd | null {
  if (!complexity) return null;
  return settings.complexityDefaults[complexity].hardMicroUsd;
}

export function softBudgetForComplexity(
  settings: ProjectBudgetSettings,
  complexity: ComplexityTier | null | undefined,
): MicroUsd | null {
  if (!complexity) return null;
  return settings.complexityDefaults[complexity].softMicroUsd;
}
