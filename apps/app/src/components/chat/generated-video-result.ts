import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai"

export type GeneratedVideoJob = {
  toolCallId: string
  id: string
  status: string
  progress?: number
  revision?: number
  updatedAt?: number
  model?: { providerID?: string; modelID?: string }
  artifact?: {
    path: string
    name: string
    mimeType: string
    bytes?: number
    durationSeconds?: number
    width?: number
    height?: number
  }
  error?: { message?: string }
}

const DEFAULT_NOTIFICATION_FRESHNESS_MS = 10 * 60 * 1_000

export function isGeneratedVideoJobRecent(
  job: GeneratedVideoJob,
  now = Date.now(),
  maxAgeMs = DEFAULT_NOTIFICATION_FRESHNESS_MS,
) {
  return typeof job.updatedAt !== "number" || now - job.updatedAt <= maxAgeMs
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

function safeWorkspaceVideoPath(value: unknown) {
  if (typeof value !== "string") return null
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null
  return path
}

function findJob(value: unknown, depth = 0): Record<string, unknown> | null {
  const candidate = record(value)
  if (!candidate || depth > 4) return null
  if (typeof candidate.id === "string" && typeof candidate.status === "string") return candidate
  return findJob(candidate.job, depth + 1) ?? findJob(candidate.result, depth + 1)
}

export function generatedVideoJobFromOutput(value: unknown, toolCallId = "video-job"):
  GeneratedVideoJob | null {
  const output = parsedOutput(value)
  if (!output || output.ok === false) return null
  const job = findJob(output)
  if (!job) return null

  const artifactRecord = record(job.artifact)
  const path = safeWorkspaceVideoPath(artifactRecord?.path)
  const mimeType = typeof artifactRecord?.mimeType === "string"
    ? artifactRecord.mimeType.trim().toLowerCase()
    : ""
  const model = record(job.model)
  const error = record(job.error)

  return {
    toolCallId,
    id: String(job.id),
    status: String(job.status),
    ...(typeof job.progress === "number" && Number.isFinite(job.progress) ? { progress: job.progress } : {}),
    ...(typeof job.revision === "number" ? { revision: job.revision } : {}),
    ...(typeof job.updatedAt === "number" ? { updatedAt: job.updatedAt } : {}),
    ...(model ? {
      model: {
        ...(typeof model.providerID === "string" ? { providerID: model.providerID } : {}),
        ...(typeof model.modelID === "string" ? { modelID: model.modelID } : {}),
      },
    } : {}),
    ...(path && mimeType.startsWith("video/") ? {
      artifact: {
        path,
        name: path.split("/").at(-1) || "generated-video",
        mimeType,
        ...(typeof artifactRecord?.bytes === "number" ? { bytes: artifactRecord.bytes } : {}),
        ...(typeof artifactRecord?.durationSeconds === "number" ? { durationSeconds: artifactRecord.durationSeconds } : {}),
        ...(typeof artifactRecord?.width === "number" ? { width: artifactRecord.width } : {}),
        ...(typeof artifactRecord?.height === "number" ? { height: artifactRecord.height } : {}),
      },
    } : {}),
    ...(error ? { error: { ...(typeof error.message === "string" ? { message: error.message } : {}) } } : {}),
  }
}

export function generatedVideoJobFromToolPart(part: ToolUIPart | DynamicToolUIPart) {
  if (part.type !== "dynamic-tool" || part.state !== "output-available") return null
  if (!["jugglework_video_generate", "jugglework_video_job_get", "jugglework_execute"].includes(part.toolName)) return null
  return generatedVideoJobFromOutput(part.output, part.toolCallId)
}

export function generatedVideoJobsFromMessages(messages: UIMessage[]) {
  const jobs = new Map<string, GeneratedVideoJob>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue
      const job = generatedVideoJobFromToolPart(part)
      if (!job) continue
      const current = jobs.get(job.id)
      if (!current || (job.revision ?? 0) >= (current.revision ?? 0)) jobs.set(job.id, job)
    }
  }
  return [...jobs.values()]
}

export function generatedVideoJobsForMessageScope(
  scopeMessages: UIMessage[],
  allMessages: UIMessage[],
) {
  const latestById = new Map(
    generatedVideoJobsFromMessages(allMessages).map((job) => [job.id, job]),
  )

  return generatedVideoJobsFromMessages(scopeMessages).filter((job) =>
    latestById.get(job.id)?.toolCallId === job.toolCallId,
  )
}
