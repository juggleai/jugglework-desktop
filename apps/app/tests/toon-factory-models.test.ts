import { describe, expect, test } from "bun:test";

import { getAllowedConnectedTextModels } from "../src/react-app/infra/provider-list-query";
import { revalidateToonModelSelection } from "../src/react-app/domains/toon-factory/toon-factory-models";

const catalog = {
  connected: ["allowed", "blocked", "config"],
  all: [
    { id: "allowed", name: "Allowed", source: "api" as const, models: {
      text: { name: "Text", capabilities: { output: { text: true } } },
      image: { name: "Image", capabilities: { output: { image: true } }, imageGeneration: { textToImage: true } },
      video: { name: "Video", modalities: { output: ["video"] }, mediaGeneration: { textToVideo: true } },
    } },
    { id: "blocked", name: "Blocked", source: "api" as const, models: { text: { name: "Blocked text", modalities: { output: ["text"] } } } },
    { id: "config", name: "Local", source: "config" as const, models: { text: { name: "Local text" } } },
    { id: "disconnected", name: "Disconnected", source: "api" as const, models: { text: { name: "No" } } },
  ],
  default: {},
};

describe("Toon Factory text model filtering", () => {
  test("keeps connected text-capable models and excludes pure image/video models", () => {
    const models = getAllowedConnectedTextModels(catalog, { checkRestriction: () => false });
    expect(models.map((model) => `${model.providerID}/${model.modelID}`)).toEqual([
      "allowed/text",
      "blocked/text",
      "config/text",
    ]);
  });

  test("applies desktop catalog and custom-provider restrictions", () => {
    const models = getAllowedConnectedTextModels(catalog, {
      allowedModels: ["allowed/text"],
      checkRestriction: ({ restriction }) => restriction === "allowCustomProviders",
    });
    expect(models.map((model) => `${model.providerID}/${model.modelID}`)).toEqual(["allowed/text"]);
  });
});

describe("Toon Factory model revalidation", () => {
  test("preserves model drift as selected_model_unavailable instead of substituting", () => {
    expect(revalidateToonModelSelection({
      kind: "image",
      selected: { kind: "image", providerID: "removed", modelID: "old" },
      imageModels: [{ ref: { providerID: "ready", modelID: "new" }, providerName: "Ready", modelName: "New", capabilities: { textToImage: true } }],
    })).toEqual({ available: false, reason: "selected_model_unavailable" });
  });

  test("reports explicit no-model and disabled-submission states", () => {
    expect(revalidateToonModelSelection({ kind: "text", textModels: [] }).reason).toBe("no_text_model_available");
    expect(revalidateToonModelSelection({ kind: "image", imageModels: [] }).reason).toBe("no_image_model_available");
    expect(revalidateToonModelSelection({ kind: "video", videoModels: [], videoBlockingReason: "no_video_model_available" }).reason).toBe("no_video_model_available");
    expect(revalidateToonModelSelection({
      kind: "video",
      selected: { kind: "video", providerID: "p", modelID: "v" },
      videoModels: [],
      videoSubmissionEnabled: false,
      videoBlockingReason: "video_submission_disabled",
    }).reason).toBe("video_submission_disabled");
  });
});
