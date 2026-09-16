import assert from "node:assert/strict"
import test from "node:test"

import {
  parseImageGenerationCapabilities,
  parseMediaGenerationCapabilities,
  parseNormalizedModelCapabilities,
  supportsVideoGenerationMode,
} from "../src/media-generation.ts"

test("normalizes explicit image generation modes", () => {
  assert.deepEqual(parseImageGenerationCapabilities({
    protocol: "openai",
    textToImage: true,
    imageToImage: true,
    multiImageToImage: true,
    inputImage: { mimeTypes: ["image/png"], maxBytes: 1000, maxCount: 16 },
    outputImage: { mimeTypes: ["image/png"] },
  }), {
    protocol: "openai",
    textToImage: true,
    imageToImage: true,
    multiImageToImage: true,
    inputImage: { mimeTypes: ["image/png"], maxBytes: 1000, maxCount: 16 },
    outputImage: { mimeTypes: ["image/png"] },
  })
})

test("normalizes explicit text and image video capabilities", () => {
  const capabilities = parseMediaGenerationCapabilities({
    protocol: "volcengine-ark-v3",
    textToVideo: true,
    imageToVideo: true,
    asyncJob: true,
    inputImage: { mimeTypes: ["image/png", "image/png", ""], maxBytes: 8_000_000, maxCount: 1 },
    outputVideo: { mimeTypes: ["video/mp4"], maxDurationSeconds: 10, resolutions: ["720p", "720p", "invalid"] },
  })

  assert.deepEqual(capabilities, {
    protocol: "volcengine-ark-v3",
    textToVideo: true,
    imageToVideo: true,
    asyncJob: true,
    inputImage: { mimeTypes: ["image/png"], maxBytes: 8_000_000, maxCount: 1 },
    outputVideo: { mimeTypes: ["video/mp4"], maxDurationSeconds: 10, resolutions: ["720p"] },
  })
  assert.equal(supportsVideoGenerationMode(capabilities, "text-to-video"), true)
  assert.equal(supportsVideoGenerationMode(capabilities, "image-to-video"), true)
})

test("does not infer generation capability from video output modality", () => {
  const capabilities = parseNormalizedModelCapabilities({ modalities: { input: ["text"], output: ["video"] } })
  assert.deepEqual(capabilities, { modalities: { input: ["text"], output: ["video"] } })
  assert.equal(capabilities?.mediaGeneration, undefined)
})

test("rejects malformed or false-only media capability records", () => {
  assert.equal(parseMediaGenerationCapabilities(null), undefined)
  assert.equal(parseMediaGenerationCapabilities({ textToVideo: false, imageToVideo: false }), undefined)
})

test("drops an unknown video protocol while preserving explicit capability", () => {
  assert.deepEqual(parseMediaGenerationCapabilities({ protocol: "unknown", textToVideo: true }), {
    textToVideo: true,
  })
})

test("built media generation runtime is importable without TypeScript source loading", async () => {
  const runtime = await import("@jugglework/types/media-generation")
  assert.deepEqual(runtime.VIDEO_RESOLUTION_PRESETS, ["480p", "720p", "1080p", "4k"])
  assert.equal(runtime.parseImageGenerationCapabilities({ textToImage: true })?.textToImage, true)
})
