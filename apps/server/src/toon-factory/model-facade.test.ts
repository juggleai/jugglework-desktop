import { describe, expect, test } from "bun:test";

import { buildToonFactoryModelCatalog } from "./model-facade.js";

const image = (overrides: Record<string, unknown> = {}) => ({
  ref: { providerID: "image-provider", modelID: "image-model" },
  providerName: "Images",
  modelName: "Image model",
  capabilities: { textToImage: true },
  availability: "ready",
  baseURL: "https://private.example/v1",
  envKeys: ["IMAGE_SECRET"],
  providerConfig: { apiKey: "top-secret" },
  ...overrides,
});

const video = (overrides: Record<string, unknown> = {}) => ({
  ref: { providerID: "video-provider", modelID: "video-model" },
  providerName: "Videos",
  modelName: "Video model",
  capabilities: { textToVideo: true },
  availability: "ready",
  credential: "top-secret",
  ...overrides,
});

describe("Toon Factory model facade", () => {
  test("filters readiness and generation modes", () => {
    const result = buildToonFactoryModelCatalog({
      imageMode: "image-to-image",
      videoMode: "image-to-video",
      imageListResult: { models: [image(), image({ ref: { providerID: "image-provider", modelID: "edit" }, capabilities: { imageToImage: true } }), image({ ref: { providerID: "image-provider", modelID: "missing" }, capabilities: { imageToImage: true }, availability: "missing_credentials" })] },
      videoStatusResult: { submissionEnabled: true, models: [video(), video({ ref: { providerID: "video-provider", modelID: "animate" }, capabilities: { imageToVideo: true } })] },
      videoListResult: { models: [video({ ref: { providerID: "video-provider", modelID: "animate" }, capabilities: { imageToVideo: true } })] },
    });

    expect(result.image.models.map((model) => model.ref.modelID)).toEqual(["edit"]);
    expect(result.video.models.map((model) => model.ref.modelID)).toEqual(["animate"]);
    expect(result.video).toMatchObject({ submissionEnabled: true, blockingReason: null });
  });

  test("distinguishes disabled submission from no ready model", () => {
    const disabled = buildToonFactoryModelCatalog({
      imageMode: "text-to-image",
      videoMode: "text-to-video",
      imageListResult: { models: [] },
      videoStatusResult: { submissionEnabled: false, models: [video()] },
      videoListResult: { models: [] },
    });
    expect(disabled.video).toEqual({ mode: "text-to-video", submissionEnabled: false, blockingReason: "video_submission_disabled", models: [] });

    const missing = buildToonFactoryModelCatalog({
      imageMode: "text-to-image",
      videoMode: "image-to-video",
      imageListResult: { models: [] },
      videoStatusResult: { submissionEnabled: false, models: [video({ availability: "missing_credentials", capabilities: { imageToVideo: true } })] },
      videoListResult: { models: [] },
    });
    expect(missing.video.blockingReason).toBe("no_video_model_available");
  });

  test("returns only public descriptor fields and redacts private config structurally", () => {
    const result = buildToonFactoryModelCatalog({
      imageMode: "text-to-image",
      videoMode: "text-to-video",
      imageListResult: { models: [image()] },
      videoStatusResult: { submissionEnabled: true, models: [video()] },
      videoListResult: { models: [video()] },
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain("top-secret");
    expect(json).not.toContain("private.example");
    expect(json).not.toContain("IMAGE_SECRET");
    expect(Object.keys(result.image.models[0]!).sort()).toEqual(["capabilities", "modelName", "providerName", "ref"]);
    expect(Object.keys(result.video.models[0]!).sort()).toEqual(["capabilities", "modelName", "providerName", "ref"]);
  });
});
