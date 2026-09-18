import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import {
  buildImageGenerationInstruction,
  imageGenerationSize,
  imageGenerationSystemInstruction,
  mergeImageGenerationSystemContext,
  parseComposerImageModels,
} from "../src/react-app/domains/session/surface/composer/image-generation";

const composerPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url),
);
const sessionSurfacePath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
);
const sessionRoutePath = fileURLToPath(
  new URL("../src/react-app/shell/session-route.tsx", import.meta.url),
);

describe("composer image generation", () => {
  test("normalizes and deduplicates ready model descriptors", () => {
    expect(parseComposerImageModels({
      models: [
        {
          ref: { providerID: "volcengine", modelID: "seedream-4-5" },
          providerName: "Volcengine",
          modelName: "Seedream 4.5",
        },
        {
          ref: { providerID: "volcengine", modelID: "seedream-4-5" },
          providerName: "Duplicate",
          modelName: "Duplicate",
        },
        { ref: { providerID: "", modelID: "invalid" } },
      ],
    })).toEqual([{
      providerID: "volcengine",
      modelID: "seedream-4-5",
      providerName: "Volcengine",
      modelName: "Seedream 4.5",
    }]);
  });

  test("maps visible ratios to provider sizes", () => {
    expect(imageGenerationSize("auto")).toBeNull();
    expect(imageGenerationSize("1:1")).toBe("1024x1024");
    expect(imageGenerationSize("3:2")).toBe("1536x1024");
    expect(imageGenerationSize("2:3")).toBe("1024x1536");
  });

  test("builds an explicit model-locked tool instruction", () => {
    const prompt = buildImageGenerationInstruction("A quiet mountain lake", {
      model: { providerID: "volcengine", modelID: "seedream-4-5" },
      providerName: "Volcengine",
      modelName: "Seedream 4.5",
      aspectRatio: "3:2",
      style: "photographic",
    });

    expect(prompt).toContain("`jugglework_image_generate`");
    expect(prompt).toContain("providerID `volcengine`");
    expect(prompt).toContain("modelID `seedream-4-5`");
    expect(prompt).toContain("`1536x1024`");
    expect(prompt).toContain("photographic style");
    expect(prompt).toEndWith("A quiet mountain lake");
  });

  test("injects image generation into system context while preserving the visible prompt", () => {
    const draft = {
      text: "A quiet mountain lake",
      resolvedText: buildImageGenerationInstruction("A quiet mountain lake", {
        model: { providerID: "volcengine", modelID: "seedream-4-5" },
        providerName: "Volcengine",
        modelName: "Seedream 4.5",
        aspectRatio: "3:2" as const,
        style: "photographic" as const,
      }),
      imageGeneration: {
        model: { providerID: "volcengine", modelID: "seedream-4-5" },
        providerName: "Volcengine",
        modelName: "Seedream 4.5",
        aspectRatio: "3:2" as const,
        style: "photographic" as const,
      },
    };

    expect(imageGenerationSystemInstruction(draft)).toContain("`jugglework_image_generate`");
    expect(mergeImageGenerationSystemContext(draft, "Workspace environment context")).toBe(
      `Workspace environment context\n\n${draft.resolvedText}`,
    );
    expect(draft.text).toBe("A quiet mountain lake");
  });

  test("rebuilds the image instruction when a queued draft lacks resolved text", () => {
    const instruction = imageGenerationSystemInstruction({
      text: "A playful corgi",
      imageGeneration: {
        model: { providerID: "volcengine", modelID: "seedream-4-5" },
        providerName: "Volcengine",
        modelName: "Seedream 4.5",
        aspectRatio: "1:1",
        style: "illustration",
      },
    });

    expect(instruction).toContain("providerID `volcengine`");
    expect(instruction).toContain("modelID `seedream-4-5`");
    expect(instruction).toContain("`1024x1024`");
    expect(instruction).toEndWith("A playful corgi");
  });

  test("only adds the menu item when a ready model exists", () => {
    const composer = readFileSync(composerPath, "utf8");
    expect(composer).toContain('kind: "image-generation" as const');
    expect(composer).toContain("props.imageGenerationModels.length > 0");
    expect(composer).not.toContain('t("composer.image_generation_no_models")');
    expect(composer).toContain("<ImageGenerationControls");
  });

  test("discovers models in the active workspace and attaches options to the draft", () => {
    const surface = readFileSync(sessionSurfacePath, "utf8");
    const route = readFileSync(sessionRoutePath, "utf8");
    expect(surface).toContain('action: "image_models_list"');
    expect(surface).toContain('args: { mode: "text-to-image" }');
    expect(surface).toContain("buildImageGenerationInstruction(resolved.trim(), imageGeneration)");
    expect(surface).toContain("{ imageGeneration }");
    expect(route).toContain("mergeImageGenerationSystemContext(draft, envSystemContext)");
    expect(route).toContain("...(systemContext ? { system: systemContext } : {})");
  });
});
