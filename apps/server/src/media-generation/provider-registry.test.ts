import { describe, expect, test } from "bun:test";
import { openAiCompatibleVideoAdapters } from "./provider-registry.js";

const env = { list: async () => [{ key: "VIDEO_KEY", value: "secret" }] } as never;

describe("video provider registry", () => {
  test("creates model-scoped OpenAI and Ark V3 adapters for one provider", () => {
    const adapters = openAiCompatibleVideoAdapters({
      provider: {
        mixed: {
          npm: "@ai-sdk/openai-compatible",
          env: ["VIDEO_KEY"],
          options: { baseURL: "https://api.example.test/v1" },
          models: {
            openai: { mediaGeneration: { protocol: "openai", textToVideo: true } },
            legacyDefault: { mediaGeneration: { textToVideo: true } },
            ark: { mediaGeneration: { protocol: "volcengine-ark-v3", imageToVideo: true } },
            chat: { name: "Chat only" },
          },
        },
      },
    } as never, env);

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "openai-compatible:mixed",
      "volcengine-ark-v3:mixed",
    ]);
    expect(adapters[0]?.matches({ providerID: "mixed", modelID: "openai" })).toBe(true);
    expect(adapters[0]?.matches({ providerID: "mixed", modelID: "legacyDefault" })).toBe(true);
    expect(adapters[0]?.matches({ providerID: "mixed", modelID: "ark" })).toBe(false);
    expect(adapters[1]?.matches({ providerID: "mixed", modelID: "ark" })).toBe(true);
    expect(adapters.some((adapter) => adapter.matches({ providerID: "mixed", modelID: "chat" }))).toBe(false);
  });
});
