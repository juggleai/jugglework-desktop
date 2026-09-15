import { describe, expect, test } from "bun:test";

import { discoverVideoModels, listReadyVideoModels, noVideoModelResult } from "./model-discovery.js";

const catalog = {
  connected: ["ready", "missing", "unsupported"],
  all: [
    {
      id: "ready",
      name: "Ready Provider",
      models: {
        t2v: { name: "T2V", mediaGeneration: { textToVideo: true, outputVideo: { mimeTypes: ["video/mp4"] } } },
        i2v: { name: "I2V", mediaGeneration: { imageToVideo: true, inputImage: { mimeTypes: ["image/png"] }, outputVideo: { mimeTypes: ["video/mp4"] } } },
        modalityOnly: { modalities: { output: ["video"] } },
      },
    },
    { id: "missing", models: { video: { mediaGeneration: { textToVideo: true } } } },
    { id: "unsupported", models: { video: { mediaGeneration: { textToVideo: true } } } },
    { id: "workspace-hidden", models: { video: { mediaGeneration: { textToVideo: true } } } },
  ],
};

const options = {
  catalog,
  supportsAdapter: (ref: { providerID: string }) => ref.providerID !== "unsupported",
  credentialReady: (ref: { providerID: string }) => ref.providerID !== "missing",
};

describe("video model discovery", () => {
  test("reports readiness diagnostics without exposing disconnected providers", () => {
    expect(discoverVideoModels(options).map((model) => [model.ref.providerID, model.ref.modelID, model.availability])).toEqual([
      ["missing", "video", "missing_credentials"],
      ["ready", "i2v", "ready"],
      ["ready", "t2v", "ready"],
      ["unsupported", "video", "unsupported_adapter"],
    ]);
  });

  test("filters ready models by requested mode", () => {
    expect(listReadyVideoModels({ ...options, mode: "text-to-video" }).map((model) => model.ref.modelID)).toEqual(["t2v"]);
    expect(listReadyVideoModels({ ...options, mode: "image-to-video" }).map((model) => model.ref.modelID)).toEqual(["i2v"]);
  });

  test("returns a stable no-model result and calls out an unused image", () => {
    expect(noVideoModelResult("image-to-video")).toEqual({
      ok: false,
      error: "no_video_model_available",
      mode: "image-to-video",
      message: "No configured provider currently has a usable image-to-video model. The reference image was not ignored.",
    });
  });
});
