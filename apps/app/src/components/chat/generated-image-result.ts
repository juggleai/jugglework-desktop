import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai"

export type GeneratedImageResult = {
  toolCallId: string
  path: string
  name: string
  mimeType: string
  bytes?: number
  model?: {
    providerID?: string
    modelID?: string
  }
  mode?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parsedOutput(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value)

  try {
    return record(JSON.parse(value))
  } catch {
    return null
  }
}

function safeWorkspaceImagePath(value: unknown) {
  if (typeof value !== "string") return null
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null
  return path
}

export function generatedImageResultFromToolPart(
  part: ToolUIPart | DynamicToolUIPart,
): GeneratedImageResult | null {
  if (
    part.type !== "dynamic-tool" ||
    part.toolName !== "jugglework_image_generate" ||
    part.state !== "output-available"
  ) {
    return null
  }

  const output = parsedOutput(part.output)
  if (output?.ok !== true) return null

  const result = record(output.result)
  const artifact = record(result?.artifact)
  const path = safeWorkspaceImagePath(artifact?.path ?? output.path)
  const mimeType = typeof artifact?.mimeType === "string" ? artifact.mimeType.trim().toLowerCase() : ""
  if (!path || !mimeType.startsWith("image/")) return null

  const name = path.split("/").at(-1) || "generated-image"
  const model = record(result?.model)
  const bytes = typeof artifact?.bytes === "number" && Number.isFinite(artifact.bytes)
    ? artifact.bytes
    : undefined

  return {
    toolCallId: part.toolCallId,
    path,
    name,
    mimeType,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(model ? {
      model: {
        ...(typeof model.providerID === "string" ? { providerID: model.providerID } : {}),
        ...(typeof model.modelID === "string" ? { modelID: model.modelID } : {}),
      },
    } : {}),
    ...(typeof result?.mode === "string" ? { mode: result.mode } : {}),
  }
}

export function generatedImageResultsFromMessages(messages: UIMessage[]) {
  const results = new Map<string, GeneratedImageResult>()

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue
      const result = generatedImageResultFromToolPart(part)
      if (result) results.set(result.path.toLowerCase(), result)
    }
  }

  return [...results.values()]
}
