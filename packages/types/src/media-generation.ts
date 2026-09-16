export const VIDEO_GENERATION_MODES = ["text-to-video", "image-to-video"] as const

export type VideoGenerationMode = (typeof VIDEO_GENERATION_MODES)[number]
export const IMAGE_GENERATION_MODES = ["text-to-image", "image-to-image", "multi-image-to-image"] as const
export type ImageGenerationMode = (typeof IMAGE_GENERATION_MODES)[number]
export const VIDEO_API_PROTOCOLS = ["openai", "volcengine-ark-v3"] as const
export type VideoApiProtocol = (typeof VIDEO_API_PROTOCOLS)[number]
export const VIDEO_RESOLUTION_PRESETS = ["480p", "720p", "1080p", "4k"] as const
export type VideoResolutionPreset = (typeof VIDEO_RESOLUTION_PRESETS)[number]

export type MediaImageInputCapabilities = {
  mimeTypes: string[]
  maxBytes?: number
  maxCount?: number
}

export type MediaVideoOutputCapabilities = {
  mimeTypes: string[]
  maxDurationSeconds?: number
  resolutions?: VideoResolutionPreset[]
}

export type MediaGenerationCapabilities = {
  protocol?: VideoApiProtocol
  textToVideo?: boolean
  imageToVideo?: boolean
  asyncJob?: boolean
  inputImage?: MediaImageInputCapabilities
  outputVideo?: MediaVideoOutputCapabilities
}

export type ImageGenerationCapabilities = {
  protocol?: "openai"
  textToImage?: boolean
  imageToImage?: boolean
  multiImageToImage?: boolean
  inputImage?: MediaImageInputCapabilities
  outputImage?: { mimeTypes: string[] }
}

export type NormalizedModelCapabilities = {
  attachment?: boolean
  modalities?: { input: string[]; output: string[] }
  mediaGeneration?: MediaGenerationCapabilities
  imageGeneration?: ImageGenerationCapabilities
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
  const resolutions = stringList(output?.resolutions).filter((value): value is VideoResolutionPreset =>
    VIDEO_RESOLUTION_PRESETS.includes(value as VideoResolutionPreset),
  )

  return {
    ...(VIDEO_API_PROTOCOLS.includes(value.protocol as VideoApiProtocol)
      ? { protocol: value.protocol as VideoApiProtocol }
      : {}),
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

export function parseImageGenerationCapabilities(value: unknown): ImageGenerationCapabilities | undefined {
  if (!isRecord(value)) return undefined
  const textToImage = value.textToImage === true
  const imageToImage = value.imageToImage === true
  const multiImageToImage = value.multiImageToImage === true
  if (!textToImage && !imageToImage && !multiImageToImage) return undefined
  const input = isRecord(value.inputImage) ? value.inputImage : null
  const output = isRecord(value.outputImage) ? value.outputImage : null
  const inputMimeTypes = stringList(input?.mimeTypes)
  const outputMimeTypes = stringList(output?.mimeTypes)
  const maxBytes = positiveNumber(input?.maxBytes)
  const maxCount = positiveNumber(input?.maxCount)
  return {
    ...(value.protocol === "openai" ? { protocol: "openai" as const } : {}),
    ...(textToImage ? { textToImage: true } : {}),
    ...(imageToImage ? { imageToImage: true } : {}),
    ...(multiImageToImage ? { multiImageToImage: true } : {}),
    ...(inputMimeTypes.length ? { inputImage: { mimeTypes: inputMimeTypes, ...(maxBytes ? { maxBytes } : {}), ...(maxCount ? { maxCount } : {}) } } : {}),
    ...(outputMimeTypes.length ? { outputImage: { mimeTypes: outputMimeTypes } } : {}),
  }
}

export function parseNormalizedModelCapabilities(value: unknown): NormalizedModelCapabilities | undefined {
  if (!isRecord(value)) return undefined
  const modalities = isRecord(value.modalities) ? value.modalities : null
  const input = stringList(modalities?.input)
  const output = stringList(modalities?.output)
  const mediaGeneration = parseMediaGenerationCapabilities(value.mediaGeneration)
  const imageGeneration = parseImageGenerationCapabilities(value.imageGeneration)
  if (value.attachment !== true && input.length === 0 && output.length === 0 && !mediaGeneration && !imageGeneration) return undefined
  return {
    ...(value.attachment === true ? { attachment: true } : {}),
    ...(input.length > 0 || output.length > 0 ? { modalities: { input, output } } : {}),
    ...(mediaGeneration ? { mediaGeneration } : {}),
    ...(imageGeneration ? { imageGeneration } : {}),
  }
}

export function supportsVideoGenerationMode(capabilities: MediaGenerationCapabilities | undefined, mode: VideoGenerationMode): boolean {
  return mode === "image-to-video" ? capabilities?.imageToVideo === true : capabilities?.textToVideo === true
}

export function supportsImageGenerationMode(capabilities: ImageGenerationCapabilities | undefined, mode: ImageGenerationMode): boolean {
  if (mode === "text-to-image") return capabilities?.textToImage === true
  if (mode === "image-to-image") return capabilities?.imageToImage === true
  return capabilities?.multiImageToImage === true
}
