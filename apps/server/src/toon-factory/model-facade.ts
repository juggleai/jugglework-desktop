import {
  parseImageGenerationCapabilities,
  parseMediaGenerationCapabilities,
  supportsImageGenerationMode,
  supportsVideoGenerationMode,
} from "@jugglework/types/media-generation"
import type {
  ToonImageGenerationMode,
  ToonImageModelDescriptor,
  ToonModelCatalogResponse,
  ToonVideoGenerationMode,
  ToonVideoModelDescriptor,
} from "@jugglework/types/toon-factory"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function publicRef(value: unknown): { providerID: string; modelID: string } | null {
  if (!isRecord(value)) return null
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : ""
  const modelID = typeof value.modelID === "string" ? value.modelID.trim() : ""
  return providerID && modelID ? { providerID, modelID } : null
}

function publicName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function imageModels(value: unknown, mode: ToonImageGenerationMode): ToonImageModelDescriptor[] {
  const models = isRecord(value) && Array.isArray(value.models) ? value.models : []
  return models.flatMap((candidate) => {
    if (!isRecord(candidate) || (candidate.availability !== undefined && candidate.availability !== "ready")) return []
    const ref = publicRef(candidate.ref)
    const capabilities = parseImageGenerationCapabilities(candidate.capabilities)
    if (!ref || !capabilities || !supportsImageGenerationMode(capabilities, mode)) return []
    return [{
      ref,
      providerName: publicName(candidate.providerName, ref.providerID),
      modelName: publicName(candidate.modelName, ref.modelID),
      capabilities,
    }]
  })
}

function videoModels(value: unknown, mode: ToonVideoGenerationMode): ToonVideoModelDescriptor[] {
  const models = isRecord(value) && Array.isArray(value.models) ? value.models : []
  return models.flatMap((candidate) => {
    if (!isRecord(candidate) || (candidate.availability !== undefined && candidate.availability !== "ready")) return []
    const ref = publicRef(candidate.ref)
    const capabilities = parseMediaGenerationCapabilities(candidate.capabilities)
    if (!ref || !capabilities || !supportsVideoGenerationMode(capabilities, mode)) return []
    return [{
      ref,
      providerName: publicName(candidate.providerName, ref.providerID),
      modelName: publicName(candidate.modelName, ref.modelID),
      capabilities,
    }]
  })
}

export function buildToonFactoryModelCatalog(input: {
  imageMode: ToonImageGenerationMode
  videoMode: ToonVideoGenerationMode
  imageListResult: unknown
  videoStatusResult: unknown
  videoListResult: unknown
}): ToonModelCatalogResponse {
  const images = imageModels(input.imageListResult, input.imageMode)
  const status = isRecord(input.videoStatusResult) ? input.videoStatusResult : {}
  const readyForMode = videoModels({ models: status.models }, input.videoMode)
  const eligible = videoModels(input.videoListResult, input.videoMode)
  const submissionEnabled = status.submissionEnabled === true && eligible.length > 0
  const blockingReason = readyForMode.length === 0
    ? "no_video_model_available" as const
    : !submissionEnabled
      ? "video_submission_disabled" as const
      : null

  return {
    image: { mode: input.imageMode, models: images },
    video: {
      mode: input.videoMode,
      submissionEnabled,
      blockingReason,
      models: submissionEnabled ? eligible : [],
    },
  }
}
