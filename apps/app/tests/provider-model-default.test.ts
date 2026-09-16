import { describe, expect, test } from "bun:test";

import { getChatSelectableModelEntries, isChatSelectableProviderModel, resolveConnectedProviderModel } from "../src/react-app/infra/provider-list-query";

const provider = (id: string, modelIds: string[]) => ({
  id,
  name: id,
  source: "api" as const,
  env: [],
  npm: "",
  models: Object.fromEntries(modelIds.map((modelID) => [modelID, {
    id: modelID,
    providerID: id,
    name: modelID,
    family: "test",
    release_date: "2026-01-01",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    interleaved: false,
    cost: { input: 0, output: 0 },
    limit: { context: 1000, output: 100 },
    options: {},
    headers: {},
  }])),
});

describe("connected provider model defaults", () => {
  test("keeps video-only generation models out of the chat picker", () => {
    expect(isChatSelectableProviderModel({
      modalities: { input: ["text"], output: ["video"] },
      mediaGeneration: { textToVideo: true },
    })).toBe(false);
    expect(isChatSelectableProviderModel({
      modalities: { input: ["text"], output: ["text", "video"] },
      mediaGeneration: { textToVideo: true },
    })).toBe(true);
    expect(isChatSelectableProviderModel({
      capabilities: {
        output: { text: false, audio: false, image: false, video: true, pdf: false },
      },
    })).toBe(false);
    expect(isChatSelectableProviderModel({
      capabilities: {
        output: { text: true, audio: false, image: false, video: true, pdf: false },
      },
    })).toBe(true);
    expect(isChatSelectableProviderModel({
      capabilities: { output: { text: false, image: true, video: false } },
    })).toBe(false);
  });

  test("omits video-only models from the shared picker entry builder", () => {
    const models = {
      seedance: {
        name: "Seedance 2.0",
        capabilities: { output: { text: false, video: true } },
      },
      seed: {
        name: "Seed 2.1",
        capabilities: { output: { text: true, video: false } },
      },
    };
    expect(getChatSelectableModelEntries(models).map(([id]) => id)).toEqual(["seed"]);
  });

  test("keeps an available remembered model", () => {
    const value = {
      all: [provider("first", ["one"]), provider("second", ["two"])],
      connected: ["first", "second"],
      default: {},
    };
    expect(resolveConnectedProviderModel(value, { providerID: "second", modelID: "two" })).toEqual({
      providerID: "second",
      modelID: "two",
    });
  });

  test("falls back to the first model of the first usable connected provider", () => {
    const value = {
      all: [provider("empty", []), provider("first", ["one", "two"]), provider("later", ["three"])],
      connected: ["empty", "first", "later"],
      default: {},
    };
    expect(resolveConnectedProviderModel(value, { providerID: "gone", modelID: "gone" })).toEqual({
      providerID: "first",
      modelID: "one",
    });
  });

  test("does not use a video-only runtime model as the chat fallback", () => {
    const first = provider("mixed", ["seedance", "chat"]);
    first.models.seedance.capabilities = {
      output: { text: false, audio: false, image: false, video: true, pdf: false },
    } as never;
    expect(resolveConnectedProviderModel({
      all: [first],
      connected: ["mixed"],
      default: {},
    }, null)).toEqual({ providerID: "mixed", modelID: "chat" });
  });

  test("replaces a remembered video-only runtime model with the next chat model", () => {
    const first = provider("mixed", ["seedance", "chat"]);
    first.models.seedance.capabilities = {
      output: { text: false, audio: false, image: false, video: true, pdf: false },
    } as never;
    expect(resolveConnectedProviderModel({
      all: [first],
      connected: ["mixed"],
      default: {},
    }, { providerID: "mixed", modelID: "seedance" })).toEqual({
      providerID: "mixed",
      modelID: "chat",
    });
  });

  test("skips blocked models and returns null when none are usable", () => {
    const value = {
      all: [provider("first", ["blocked", "allowed"])],
      connected: ["first"],
      default: {},
    };
    expect(resolveConnectedProviderModel(value, null, {
      isAllowed: ({ model }) => model.modelID !== "blocked",
    })?.modelID).toBe("allowed");
    expect(resolveConnectedProviderModel(value, null, { isAllowed: () => false })).toBeNull();
  });
});
