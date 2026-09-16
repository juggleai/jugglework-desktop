import { describe, expect, test } from "bun:test";
import { callMediaGenerationExtensionAction, type MediaGenerationExtensionRuntime } from "./media-generation.js";

const runtime: MediaGenerationExtensionRuntime = {
  status: async () => ({}),
  listModels: async () => [],
  generate: async (input) => input,
  getJob: async () => ({}),
  cancelJob: async () => ({}),
};

describe("media generation extension resolution input", () => {
  test("accepts Ark resolution presets and legacy pixel dimensions", async () => {
    for (const resolution of ["480p", "720p", "1080p", "4k", "1280x720"]) {
      const response = await callMediaGenerationExtensionAction(runtime, "video_generate", {
        prompt: "waves",
        mode: "text-to-video",
        resolution,
        clientRequestId: `request-${resolution}`,
      }, {});
      expect((response as { result: { resolution: string } }).result.resolution).toBe(resolution);
    }
  });

  test("rejects unsupported free-form resolution values", async () => {
    await expect(callMediaGenerationExtensionAction(runtime, "video_generate", {
      prompt: "waves",
      mode: "text-to-video",
      resolution: "2k",
      clientRequestId: "request-invalid",
    }, {})).rejects.toThrow("invalid_video_generation_payload");
  });
});
