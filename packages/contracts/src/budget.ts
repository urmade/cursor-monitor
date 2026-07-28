import { z } from 'zod';

const microUsdField = z
  .union([z.string(), z.number(), z.bigint()])
  .optional()
  .nullable()
  .transform((v) => {
    if (v == null) return null;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      return BigInt(Math.round(v * 1_000_000));
    }
    const s = String(v).trim();
    if (!/^\d+$/.test(s)) return null;
    return BigInt(s);
  });

const tierSchema = z
  .object({
    softMicroUsd: microUsdField,
    hardMicroUsd: microUsdField,
    softUsd: z.number().finite().optional(),
    hardUsd: z.number().finite().optional(),
  })
  .partial();

export const ProjectBudgetSettingsSchema = z.object({
  complexityDefaults: z
    .object({
      low: tierSchema.optional(),
      medium: tierSchema.optional(),
      high: tierSchema.optional(),
    })
    .optional(),
  burnCapMicroUsd: microUsdField,
  burnCapUsd: z.number().finite().optional(),
  burnSoftRatio: z.number().min(0).max(1).optional(),
  blockOnBurnCap: z.boolean().optional(),
  reserveMicroUsdPerRun: microUsdField,
  reserveUsd: z.number().finite().optional(),
});

export type ProjectBudgetSettingsInput = z.infer<typeof ProjectBudgetSettingsSchema>;
