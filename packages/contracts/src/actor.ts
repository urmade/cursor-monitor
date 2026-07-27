import { z } from 'zod';

export const HumanActorSchema = z.object({
  kind: z.literal('human'),
  userId: z.string().uuid(),
});

export const AgentActorSchema = z.object({
  kind: z.literal('agent'),
  runId: z.string().uuid(),
  workItemId: z.string().uuid(),
});

export const SystemActorSchema = z.object({
  kind: z.literal('system'),
  reason: z.string().min(1),
});

export const ApiTokenActorSchema = z.object({
  kind: z.literal('api_token'),
  tokenId: z.string().uuid(),
});

export const ActorSchema = z.discriminatedUnion('kind', [
  HumanActorSchema,
  AgentActorSchema,
  SystemActorSchema,
  ApiTokenActorSchema,
]);

export type Actor = z.infer<typeof ActorSchema>;
export type HumanActor = z.infer<typeof HumanActorSchema>;
