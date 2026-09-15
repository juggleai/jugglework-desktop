export const VIDEO_GENERATION_MODES = ["text-to-video", "image-to-video"] as const

export type VideoGenerationMode = (typeof VIDEO_GENERATION_MODES)[number]

export type MediaImageInputCapabilities = {
  mimeTypes: string[]
  maxBytes?: number
  maxCount?: number
}

export type MediaVideoOutputCapabilities = {
  mimeTypes: string[]
  maxDurationSeconds?: number
  resolutions?: string[]
}

export type MediaGenerationCapabilities = {
  textToVideo?: boolean
  imageToVideo?: boolean
  asyncJob?: boolean
  inputImage?: MediaImageInputCapabilities
  outputVideo?: MediaVideoOutputCapabilities
}

export type NormalizedModelCapabilities = {
  attachment?: boolean
  modalities?: { input: string[]; output: string[] }
  mediaGeneration?: MediaGenerationCapabilities
}

export type VideoModelRef = { providerID: string; modelID: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const positiveNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : []

export function parseMediaGenerationCapabilities(value: unknown): MediaGenerationCapabilities | undefined {
  if (!isRecord(value)) return undefined
  const textToVideo = value.textToVideo === true
  const imageToVideo = value.imageToVideo === true
  if (!textToVideo && !imageToVideo) return undefined

  const input = isRecord(value.inputImage) ? value.inputImage : null
  const inputMimeTypes = stringList(input?.mimeTypes)
  const output = isRecord(value.outputVideo) ? value.outputVideo : null
  const outputMimeTypes = stringList(output?.mimeTypes)
  const maxBytes = positiveNumber(input?.maxBytes)
  const maxCount = positiveNumber(input?.maxCount)
  const maxDurationSeconds = positiveNumber(output?.maxDurationSeconds)
  const resolutions = stringList(output?.resolutions)

  return {
    ...(textToVideo ? { textToVideo: true } : {}),
    ...(imageToVideo ? { imageToVideo: true } : {}),
    ...(value.asyncJob === true ? { asyncJob: true } : {}),
    ...(input && inputMimeTypes.length > 0 ? {
      inputImage: {
        mimeTypes: inputMimeTypes,
        ...(maxBytes ? { maxBytes } : {}),
        ...(maxCount ? { maxCount } : {}),
      },
    } : {}),
    ...(output && outputMimeTypes.length > 0 ? {
      outputVideo: {
        mimeTypes: outputMimeTypes,
        ...(maxDurationSeconds ? { maxDurationSeconds } : {}),
        ...(resolutions.length > 0 ? { resolutions } : {}),
      },
    } : {}),
  }
}

export function parseNormalizedModelCapabilities(value: unknown): NormalizedModelCapabilities | undefined {
  if (!isRecord(value)) return undefined
  const modalities = isRecord(value.modalities) ? value.modalities : null
  const input = stringList(modalities?.input)
  const output = stringList(modalities?.output)
  const mediaGeneration = parseMediaGenerationCapabilities(value.mediaGeneration)
  if (value.attachment !== true && input.length === 0 && output.length === 0 && !mediaGeneration) return undefined
  return {
    ...(value.attachment === true ? { attachment: true } : {}),
    ...(input.length > 0 || output.length > 0 ? { modalities: { input, output } } : {}),
    ...(mediaGeneration ? { mediaGeneration } : {}),
  }
}

export function supportsVideoGenerationMode(capabilities: MediaGenerationCapabilities | undefined, mode: VideoGenerationMode): boolean {
  return mode === "image-to-video" ? capabilities?.imageToVideo === true : capabilities?.textToVideo === true
}
