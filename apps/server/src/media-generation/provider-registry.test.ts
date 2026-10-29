import { describe, expect, test } from "bun:test";
import { openAiCompatibleVideoAdapters } from "./provider-registry.js";
import { discoverVideoModels, listReadyVideoModels } from "./model-discovery.js";

describe("video provider registry", () => {
  test("managed billing gates both discovery and adapters without changing BYOK", async () => {
    const provider = (billing?: unknown) => ({
      npm: "@ai-sdk/openai-compatible", env: ["VIDEO_KEY"], options: { baseURL: "https://api.example.test/v1" },
      models: { video: { mediaGeneration: { protocol: "openai", textToVideo: true }, managedMediaBilling: billing } },
    });
    for (const [raw, ready] of [
      [provider({ required: true, version: 1, supported: false, reason: "managed_media_billing_unavailable" }), false],
      [provider({ required: true }), false],
      [provider({ required: true, version: 1, supported: false }), false],
      [provider({ required: true, version: 2, supported: true }), false],
      [provider({ required: true, version: 1, supported: true }), true],
      [provider(), true],
    ] as const) {
      const adapters = await openAiCompatibleVideoAdapters({ provider: { videos: raw } }, "ws", async () => "secret");
      const options = { catalog: { connected: ["videos"], all: [{ id: "videos", models: raw.models! }] }, disabledProviders: [], supportsAdapter: () => true, credentialReady: () => true };
      expect((await discoverVideoModels(options))[0]?.availability).toBe(ready ? "ready" : "managed_billing_unavailable");
      expect(await listReadyVideoModels(options)).toHaveLength(ready ? 1 : 0);
      expect(adapters.some((adapter) => adapter.matches({ providerID: "videos", modelID: "video" }))).toBe(ready);
    }
  });

  test("creates model-scoped OpenAI and Ark V3 adapters for one provider", async () => {
    const adapters = await openAiCompatibleVideoAdapters({
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
    } as never, "ws", async () => "secret");

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "openai-compatible:mixed",
      "openai-compatible:mixed",
      "volcengine-ark-v3:mixed",
    ]);
    expect(adapters[0]?.matches({ providerID: "mixed", modelID: "openai" })).toBe(true);
    expect(adapters[1]?.matches({ providerID: "mixed", modelID: "legacyDefault" })).toBe(true);
    expect(adapters[0]?.matches({ providerID: "mixed", modelID: "ark" })).toBe(false);
    expect(adapters[2]?.matches({ providerID: "mixed", modelID: "ark" })).toBe(true);
    expect(adapters.some((adapter) => adapter.matches({ providerID: "mixed", modelID: "chat" }))).toBe(false);
    expect(adapters[0]?.binding).toMatchObject({ protocol: "openai", origin: "https://api.example.test" });
  });
});
