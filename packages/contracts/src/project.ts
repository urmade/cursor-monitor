import { z } from 'zod';

export const ProjectRoleSchema = z.enum([
  'owner',
  'maintainer',
  'member',
  'viewer',
]);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const OwnerClassSchema = z.enum(['ai', 'human', 'external']);
export type OwnerClass = z.infer<typeof OwnerClassSchema>;

export const ComplexitySchema = z.enum(['low', 'medium', 'high']);
export type Complexity = z.infer<typeof ComplexitySchema>;

export const ProjectTemplateSchema = z.enum(['default', 'minimal', 'empty']);
export type ProjectTemplate = z.infer<typeof ProjectTemplateSchema>;

const ArtifactEvidenceKindSchema = z.enum([
  'pr',
  'branch',
  'preview',
  'artifact',
  'link',
]);

/** Boolean legacy form or structured Phase 7 form. */
const AcceptanceCriteriaConceptSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean(),
    requiredAtStageId: z.string().uuid().optional(),
  }),
]);

const VisualConfirmationConceptSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean(),
    requiredAtStageId: z.string().uuid().optional(),
    evidenceKinds: z
      .array(ArtifactEvidenceKindSchema)
      .min(1)
      .default(['preview', 'artifact']),
  }),
]);

export const OptionalConceptsSchema = z.object({
  acceptanceCriteria: AcceptanceCriteriaConceptSchema.default(false),
  visualConfirmation: VisualConfirmationConceptSchema.default(false),
});
export type OptionalConcepts = z.infer<typeof OptionalConceptsSchema>;

export type NormalizedOptionalConcepts = {
  acceptanceCriteria: {
    enabled: boolean;
    requiredAtStageId?: string;
  };
  visualConfirmation: {
    enabled: boolean;
    requiredAtStageId?: string;
    evidenceKinds: Array<z.infer<typeof ArtifactEvidenceKindSchema>>;
  };
};

/** Normalize boolean-or-object optional_concepts to the structured form. */
export function normalizeOptionalConcepts(
  raw: unknown,
): NormalizedOptionalConcepts {
  const parsed = OptionalConceptsSchema.safeParse(raw ?? {});
  const data = parsed.success
    ? parsed.data
    : { acceptanceCriteria: false, visualConfirmation: false };

  const ac = data.acceptanceCriteria;
  const vc = data.visualConfirmation;

  return {
    acceptanceCriteria:
      typeof ac === 'boolean'
        ? { enabled: ac }
        : {
            enabled: ac.enabled,
            ...(ac.requiredAtStageId
              ? { requiredAtStageId: ac.requiredAtStageId }
              : {}),
          },
    visualConfirmation:
      typeof vc === 'boolean'
        ? {
            enabled: vc,
            evidenceKinds: ['preview', 'artifact'],
          }
        : {
            enabled: vc.enabled,
            evidenceKinds: vc.evidenceKinds ?? ['preview', 'artifact'],
            ...(vc.requiredAtStageId
              ? { requiredAtStageId: vc.requiredAtStageId }
              : {}),
          },
  };
}

export function isAcceptanceCriteriaEnabled(raw: unknown): boolean {
  return normalizeOptionalConcepts(raw).acceptanceCriteria.enabled;
}

export function isVisualConfirmationEnabled(raw: unknown): boolean {
  return normalizeOptionalConcepts(raw).visualConfirmation.enabled;
}

export const CreateProjectInputSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[A-Z][A-Z0-9]*$/, 'Project key must be uppercase alphanumeric'),
  name: z.string().min(1).max(200),
  description: z.string().max(5_000).optional(),
  template: ProjectTemplateSchema.default('default'),
});

export const CreateWorkItemInputSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).optional(),
  complexity: ComplexitySchema.optional(),
  labelKeys: z.array(z.string()).optional(),
});
