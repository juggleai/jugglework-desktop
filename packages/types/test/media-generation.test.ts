import assert from "node:assert/strict"
import test from "node:test"

import {
  parseMediaGenerationCapabilities,
  parseNormalizedModelCapabilities,
  supportsVideoGenerationMode,
} from "../src/media-generation.ts"

test("normalizes explicit text and image video capabilities", () => {
  const capabilities = parseMediaGenerationCapabilities({
    textToVideo: true,
    imageToVideo: true,
    asyncJob: true,
    inputImage: { mimeTypes: ["image/png", "image/png", ""], maxBytes: 8_000_000, maxCount: 1 },
    outputVideo: { mimeTypes: ["video/mp4"], maxDurationSeconds: 10, resolutions: ["1280x720"] },
  })

  assert.deepEqual(capabilities, {
    textToVideo: true,
    imageToVideo: true,
    asyncJob: true,
    inputImage: { mimeTypes: ["image/png"], maxBytes: 8_000_000, maxCount: 1 },
    outputVideo: { mimeTypes: ["video/mp4"], maxDurationSeconds: 10, resolutions: ["1280x720"] },
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
