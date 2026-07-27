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

export const OptionalConceptsSchema = z.object({
  acceptanceCriteria: z.boolean().default(false),
  visualConfirmation: z.boolean().default(false),
});

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
