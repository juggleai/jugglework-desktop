import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import type { ClaudeWorkerInternalTools, ClaudeWorkerRunRequest } from "./schemas.js"

const commonShape = {
  expectedRevision: z.number().int().nonnegative().describe("Revision returned by context; use 0 only for the initial context read."),
}

const definitions = {
  context: {
    description: "Read bounded JuggleWork workspace/session context and the current revision.",
    sideEffect: "read" as const,
    schema: z.object(commonShape).strict(),
  },
  query: {
    description: "Run a side-effect-free JuggleWork query.",
    sideEffect: "read" as const,
    schema: z.object({ ...commonShape, id: z.enum(["session.snapshot", "skills.list", "artifacts.list"]), args: z.record(z.string(), z.unknown()).optional() }).strict(),
  },
  execute: {
    description: "Execute an attributed JuggleWork command after Server authorization.",
    sideEffect: "write" as const,
    schema: z.object({ ...commonShape, id: z.literal("session.abort"), args: z.object({ runId: z.string().trim().min(1).max(256) }).strict() }).strict(),
  },
  safe_glob: {
    description: "Find files with a bounded glob inside the authorized workspace.",
    sideEffect: "read" as const,
    schema: z.object({ ...commonShape, pattern: z.string().trim().min(1).max(512), path: z.string().trim().max(4096).optional() }).strict(),
  },
  search: {
    description: "Search literal text with bounded results inside the authorized workspace.",
    sideEffect: "read" as const,
    schema: z.object({ ...commonShape, pattern: z.string().trim().min(1).max(1024), path: z.string().trim().max(4096).optional(), include: z.string().trim().max(512).optional() }).strict(),
  },
  skill: {
    description: "List skills or retrieve bounded skill guidance.",
    sideEffect: "read" as const,
    schema: z.object({ ...commonShape, name: z.string().trim().min(1).max(128).optional() }).strict(),
  },
  artifact: {
    description: "List, read, or write a bounded JuggleWork outbox artifact.",
    sideEffect: "artifact" as const,
    schema: z.object({
      ...commonShape,
      operation: z.enum(["list", "read", "write"]),
      path: z.string().trim().min(1).max(4096).optional(),
      content: z.string().max(1_000_000).optional(),
    }).strict(),
  },
} as const

export type JuggleWorkInternalToolName = keyof typeof definitions

export interface InternalToolBridge {
  call(name: JuggleWorkInternalToolName, args: Record<string, unknown>, sideEffect: "read" | "write"): Promise<unknown>
}

export function createInternalToolBridge(input: {
  configuration: ClaudeWorkerInternalTools
  run: Pick<ClaudeWorkerRunRequest, "workspaceId" | "sessionId">
  fetch?: typeof fetch
  now?: () => number
}): InternalToolBridge {
  const fetchImpl = input.fetch ?? fetch
  return {
    async call(name, args, sideEffect) {
      if (input.configuration.credentialExpiresAt <= (input.now?.() ?? Date.now())) throw new Error("Internal tool credential expired")
      const response = await fetchImpl(input.configuration.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-jugglework-claude-tool-credential": input.configuration.credential,
        },
        body: JSON.stringify({
          schemaVersion: input.configuration.schemaVersion,
          workspaceId: input.run.workspaceId,
          sessionId: input.run.sessionId,
          actor: input.configuration.actor,
          tool: name,
          sideEffect,
          expectedRevision: args.expectedRevision,
          args,
        }),
      })
      const payload = await response.json() as { ok?: boolean; result?: unknown; error?: { message?: string } }
      if (!response.ok || payload.ok !== true) throw new Error(payload.error?.message ?? "Internal tool authorization failed")
      return payload.result
    },
  }
}

export function createJuggleWorkSdkMcpServer(input: {
  bridge: InternalToolBridge
}): McpSdkServerConfigWithInstance {
  const tools = (Object.entries(definitions) as Array<[JuggleWorkInternalToolName, typeof definitions[JuggleWorkInternalToolName]]>)
    .map(([name, definition]) => tool(
      name,
      definition.description,
      definition.schema.shape,
      async (args) => {
        try {
          const sideEffect = name === "artifact"
            ? (args as { operation?: unknown }).operation === "write" ? "write" : "read"
            : definition.sideEffect
          const result = await input.bridge.call(name, args as Record<string, unknown>, sideEffect as "read" | "write")
          return { content: [{ type: "text", text: JSON.stringify(result) }] }
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Internal tool failed" }] }
        }
      },
      { alwaysLoad: true, annotations: { readOnlyHint: definition.sideEffect === "read" } },
    ))
  return createSdkMcpServer({
    name: "jugglework",
    version: "1.0.0",
    instructions: "Use these narrow tools for JuggleWork state and artifacts. Every call is reauthorized by JuggleWork Server.",
    tools,
    alwaysLoad: true,
  })
}
