import { z } from "zod"

import {
  juggleworkAffordanceDescriptorSchema,
  juggleworkProviderRefSchema,
} from "./jugglework-affordance.js"

export const juggleworkGuidanceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: juggleworkProviderRefSchema,
  loading: z.enum(["eager", "catalog", "on-demand"]),
})
export type JuggleWorkGuidanceDescriptor = z.infer<typeof juggleworkGuidanceDescriptorSchema>

export const juggleworkFeatureContributionSchema = z.object({
  featureId: z.string().trim().min(1),
  provider: juggleworkProviderRefSchema,
  affordances: z.array(juggleworkAffordanceDescriptorSchema),
  guidance: z.array(juggleworkGuidanceDescriptorSchema),
})
export type JuggleWorkFeatureContribution = z.infer<typeof juggleworkFeatureContributionSchema>

export const juggleworkProviderCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  contributions: z.array(juggleworkFeatureContributionSchema),
})
export type JuggleWorkProviderCatalog = z.infer<typeof juggleworkProviderCatalogSchema>

export const juggleworkCapabilityResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    data: z.unknown(),
    additionalContext: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("guidance"),
    instructions: z.array(z.string()),
  }),
  z.object({
    status: z.literal("requires-user-action"),
    message: z.string(),
    action: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    retryable: z.boolean(),
  }),
])
export type JuggleWorkCapabilityResult = z.infer<typeof juggleworkCapabilityResultSchema>
