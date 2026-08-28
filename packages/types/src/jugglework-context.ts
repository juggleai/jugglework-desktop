import { z } from "zod"

import {
  juggleworkAffordanceDescriptorSchema,
  juggleworkProviderRefSchema,
} from "./jugglework-affordance.js"
import { juggleworkFeatureContributionSchema } from "./jugglework-provider.js"

export const JUGGLEWORK_CONTEXT_SCHEMA_VERSION = 1

export const juggleworkSessionRefSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  title: z.string().optional(),
})
export type JuggleWorkSessionRef = z.infer<typeof juggleworkSessionRefSchema>

export const juggleworkScreenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    route: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("settings"),
    route: z.string(),
    workspaceId: z.string().optional(),
    panel: z.string(),
  }),
  z.object({
    kind: z.literal("other"),
    route: z.string(),
  }),
])
export type JuggleWorkScreen = z.infer<typeof juggleworkScreenSchema>

export const juggleworkConversationLayoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("single"),
    sessionId: z.string(),
  }),
  z.object({
    kind: z.literal("split"),
    primarySessionId: z.string(),
    secondarySessionId: z.string(),
    focused: z.enum(["primary", "secondary"]),
  }),
])
export type JuggleWorkConversationLayout = z.infer<typeof juggleworkConversationLayoutSchema>

export const juggleworkPanelTabSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "artifact"]),
  label: z.string(),
  url: z.string().optional(),
  status: z.enum(["loading", "ready"]).optional(),
})
export type JuggleWorkPanelTab = z.infer<typeof juggleworkPanelTabSchema>

export const juggleworkResourceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  kind: z.enum(["workspace", "session", "screen", "side-panel", "settings"]),
  title: z.string(),
  provider: juggleworkProviderRefSchema,
  state: z.record(z.string(), z.unknown()),
})
export type JuggleWorkResourceDescriptor = z.infer<typeof juggleworkResourceDescriptorSchema>

export const juggleworkContextSnapshotSchema = z.object({
  schemaVersion: z.literal(JUGGLEWORK_CONTEXT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  capturedAt: z.string(),
  screen: juggleworkScreenSchema,
  conversations: z.object({
    tabs: z.array(juggleworkSessionRefSchema),
    layout: juggleworkConversationLayoutSchema,
  }),
  chrome: z.object({
    sidebarOpen: z.boolean(),
    applicationMenuVisible: z.boolean(),
    rightSidebarExpanded: z.boolean(),
  }),
  execution: z.object({
    queries: z.literal("parallel"),
    commands: z.literal("serialized"),
    busyCommandId: z.string().nullable(),
    busyActor: z.string().nullable(),
  }),
  sidePanel: z.object({
    open: z.boolean(),
    ownerSessionId: z.string().nullable(),
    kind: z.enum(["panel", "files", "extensions", "voice"]).nullable(),
    tabs: z.array(juggleworkPanelTabSchema),
    activeTabId: z.string().nullable(),
  }),
  resources: z.array(juggleworkResourceDescriptorSchema),
  availableAffordances: z.array(juggleworkAffordanceDescriptorSchema),
  contributions: z.array(juggleworkFeatureContributionSchema),
})
export type JuggleWorkContextSnapshot = z.infer<typeof juggleworkContextSnapshotSchema>
