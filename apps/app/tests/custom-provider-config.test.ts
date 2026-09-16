import { describe, expect, test } from "bun:test";

import en from "../src/i18n/locales/en";
import zh from "../src/i18n/locales/zh";
import {
  buildCustomProviderConfig,
  CUSTOM_PROVIDER_NPM,
  CUSTOM_PROVIDER_RESPONSES_NPM,
  customProviderCredentialEnv,
  customProviderCredentialEnvEntry,
  customProviderModelType,
  customProviderInputFromConfigContent,
  customProviderInputFromProvider,
  formatConfigWithCustomProvider,
  formatConfigWithoutCustomProvider,
  normalizeCustomProviderId,
  normalizeCustomProviderInput,
  parseCustomProviderModels,
  validateCustomProviderInput,
  type CustomProviderInput,
} from "../src/react-app/domains/connections/provider-auth/custom-provider-config";

const baseInput = (overrides: Partial<CustomProviderInput> = {}): CustomProviderInput =>
  normalizeCustomProviderInput({
    providerId: "my-relay",
    name: "My Relay",
    baseUrl: "https://api.example.com/v1",
    models: [{ id: "gpt-4o", name: "GPT-4o" }],
    ...overrides,
  });

describe("custom provider raw config edit source", () => {
  test("keeps video metadata when the runtime provider projection drops it", () => {
    const draft = customProviderInputFromConfigContent(`{
      "provider": {
        "huoshan": {
          "npm": "@ai-sdk/openai-compatible",
          "name": "huoshan",
          "env": ["CUSTOM_HUOSHAN_API_KEY"],
          "options": { "baseURL": "https://ark.cn-beijing.volces.com/api/v3" },
          "models": {
            "doubao-seedance-2-0-260128": {
              "name": "seedance2.0",
              "modalities": { "input": ["text", "image"], "output": ["video"] },
              "mediaGeneration": {
                "protocol": "volcengine-ark-v3",
                "textToVideo": true,
                "imageToVideo": true,
                "outputVideo": { "mimeTypes": ["video/mp4"], "resolutions": ["480p", "720p", "1080p", "4k"] }
              }
            }
          }
        }
      }
    }`, "huoshan", {
      id: "huoshan",
      name: "huoshan",
      models: {
        "doubao-seedance-2-0-260128": {
          id: "doubao-seedance-2-0-260128",
          name: "seedance2.0",
          api: { npm: CUSTOM_PROVIDER_NPM },
        },
      },
    });
    expect(draft?.models[0]).toEqual({
      id: "doubao-seedance-2-0-260128",
      name: "seedance2.0",
      chat: false,
      mediaGeneration: {
        protocol: "volcengine-ark-v3",
        textToVideo: true,
        imageToVideo: true,
        outputVideo: { mimeTypes: ["video/mp4"], resolutions: ["480p", "720p", "1080p", "4k"] },
      },
    });
  });
});

describe("normalizeCustomProviderId", () => {
  test("folds a display name into a config-safe key", () => {
    expect(normalizeCustomProviderId("  My Relay 中转 ")).toBe("my-relay");
    expect(normalizeCustomProviderId("Foo//Bar")).toBe("foo-bar");
    expect(normalizeCustomProviderId("--edge--")).toBe("edge");
  });
});

describe("customProviderModelType", () => {
  test("defaults models without generation metadata to text", () => {
    expect(customProviderModelType({})).toBe("text");
  });

  test("recognizes image and video generation models", () => {
    expect(customProviderModelType({ imageGeneration: { textToImage: true } })).toBe("image");
    expect(customProviderModelType({ mediaGeneration: { textToVideo: true } })).toBe("video");
  });

  test("prefers video when a legacy model contains mixed generation metadata", () => {
    expect(customProviderModelType({
      imageGeneration: { textToImage: true },
      mediaGeneration: { textToVideo: true },
    })).toBe("video");
  });
});

describe("parseCustomProviderModels", () => {
  test("reads one model per line and keeps ids with colons", () => {
    expect(parseCustomProviderModels("gpt-4o\n qwen3:8b \n")).toEqual([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "qwen3:8b", name: "qwen3:8b" },
    ]);
  });

  test("supports `id = Display name` and drops duplicates", () => {
    expect(parseCustomProviderModels("a = Model A, a = again, b")).toEqual([
      { id: "a", name: "Model A" },
      { id: "b", name: "b" },
    ]);
  });
});

describe("normalizeCustomProviderInput", () => {
  test("trims the base URL and falls back to the id for a blank name", () => {
    const input = normalizeCustomProviderInput({
      providerId: " My Relay ",
      name: "   ",
      baseUrl: "https://api.example.com/v1//  ".trim(),
      models: [{ id: " gpt-4o ", name: "  " }],
    });

    expect(input.providerId).toBe("my-relay");
    expect(input.name).toBe("my-relay");
    expect(input.baseUrl).toBe("https://api.example.com/v1");
    expect(input.models).toEqual([{ id: "gpt-4o", name: "gpt-4o" }]);
  });
});

describe("customProviderInputFromProvider", () => {
  test("builds an editable draft from an OpenAI-compatible local model group", () => {
    expect(customProviderInputFromProvider({
      id: "my-relay",
      name: "My Relay",
      options: { baseURL: "https://api.example.com/v1" },
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          name: "GPT-4o",
          api: { npm: "@ai-sdk/openai-compatible" },
          limit: { context: 200000, output: 32000 },
        },
      },
    })).toEqual({
      providerId: "my-relay",
      name: "My Relay",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o", contextLimit: 200000, outputLimit: 32000 }],
    });
  });

  test("preserves different per-model limits in the structured editor", () => {
    expect(customProviderInputFromProvider({
      id: "mixed-limits",
      name: "Mixed limits",
      options: { baseURL: "https://api.example.com/v1" },
      models: {
        first: {
          id: "first",
          name: "First",
          api: { npm: "@ai-sdk/openai-compatible" },
          limit: { context: 1000, output: 100 },
        },
        second: {
          id: "second",
          name: "Second",
          api: { npm: "@ai-sdk/openai-compatible" },
          limit: { context: 2000, output: 100 },
        },
      },
    })?.models).toEqual([
      { id: "first", name: "First", contextLimit: 1000, outputLimit: 100 },
      { id: "second", name: "Second", contextLimit: 2000, outputLimit: 100 },
    ]);
  });
});

describe("validateCustomProviderInput", () => {
  test("accepts a complete input", () => {
    expect(validateCustomProviderInput(baseInput())).toBe(null);
  });

  test("rejects ids reserved for cloud-managed providers", () => {
    expect(validateCustomProviderInput(baseInput({ providerId: "lpr_openrouter" }))).toBe(
      "providers.custom_id_reserved",
    );
    expect(validateCustomProviderInput(baseInput({ providerId: "jugglework" }))).toBe(
      "providers.custom_id_reserved",
    );
  });

  test("requires an http(s) base URL and at least one model", () => {
    expect(validateCustomProviderInput(baseInput({ baseUrl: "" }))).toBe(
      "providers.custom_base_url_required",
    );
    expect(validateCustomProviderInput(baseInput({ baseUrl: "api.example.com" }))).toBe(
      "providers.custom_base_url_invalid",
    );
    expect(validateCustomProviderInput(baseInput({ models: [] }))).toBe(
      "providers.custom_models_required",
    );
  });

  test("takes both limits or neither", () => {
    expect(validateCustomProviderInput(baseInput({ contextLimit: 200000 }))).toBe(
      "providers.custom_limits_incomplete",
    );
    expect(
      validateCustomProviderInput(baseInput({ contextLimit: 200000, outputLimit: 32000 })),
    ).toBe(null);
    expect(
      validateCustomProviderInput(baseInput({ contextLimit: Number.NaN, outputLimit: 32000 })),
    ).toBe("providers.custom_limits_invalid");
  });

  test("every validation key resolves to a message in en and zh", () => {
    const keys = [
      "providers.provider_id_required",
      "providers.custom_id_invalid",
      "providers.custom_id_reserved",
      "providers.custom_base_url_required",
      "providers.custom_base_url_invalid",
      "providers.custom_models_required",
      "providers.custom_limits_incomplete",
      "providers.custom_limits_invalid",
    ] as const;

    for (const key of keys) {
      expect((en as Record<string, string>)[key]).toBeString();
      expect((zh as Record<string, string>)[key]).toBeString();
    }
  });

  test("the custom-provider UI strings are translated in both en and zh", () => {
    const customKeys = (locale: Record<string, string>) =>
      Object.keys(locale)
        .filter((key) => key.startsWith("providers.custom_"))
        .sort();

    const enKeys = customKeys(en as Record<string, string>);
    expect(enKeys.length).toBeGreaterThan(0);
    expect(customKeys(zh as Record<string, string>)).toEqual(enKeys);
  });
});

describe("buildCustomProviderConfig", () => {
  test("writes an openai-compatible block with the base URL and no credential", () => {
    const config = buildCustomProviderConfig(baseInput());

    expect(config).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "My Relay",
      options: { baseURL: "https://api.example.com/v1" },
      models: { "gpt-4o": { name: "GPT-4o" } },
    });
    expect(JSON.stringify(config)).not.toContain("apiKey");
  });

  test("applies the optional limits to every model", () => {
    const config = buildCustomProviderConfig(
      baseInput({
        models: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ],
        contextLimit: 200000,
        outputLimit: 32000,
      }),
    );

    expect(config.models).toEqual({
      a: { name: "A", limit: { context: 200000, output: 32000 } },
      b: { name: "B", limit: { context: 200000, output: 32000 } },
    });
  });

  test("writes only explicitly selected reasoning effort variants", () => {
    const config = buildCustomProviderConfig(
      baseInput({
        models: [{
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoningDepths: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
        }],
        contextLimit: 1_000_000,
        outputLimit: 120_000,
      }),
    );

    expect(config.models?.["gpt-5.6-sol"]).toEqual({
      name: "GPT-5.6 Sol",
      reasoning: true,
      variants: {
        none: {},
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
        xhigh: { reasoningEffort: "xhigh" },
        max: { reasoningEffort: "max" },
        ultra: { reasoningEffort: "ultra" },
      },
      limit: { context: 1_000_000, output: 120_000 },
    });
  });

  test("writes none as an empty variant rather than reasoningEffort none", () => {
    const config = buildCustomProviderConfig(baseInput({
      models: [{ id: "optional-reasoning", name: "Optional reasoning", reasoningDepths: ["none", "high"] }],
    }));
    expect(config.models?.["optional-reasoning"]?.variants).toEqual({
      none: {},
      high: { reasoningEffort: "high" },
    });
  });

  test("does not infer reasoning support from a GPT model id when none is configured", () => {
    const config = buildCustomProviderConfig(baseInput({
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    }));
    expect(config.models?.["gpt-5.6-sol"]).toEqual({ name: "GPT-5.6 Sol" });
  });

  test("round-trips supported reasoning depths in canonical order", () => {
    const draft = customProviderInputFromProvider({
      id: "reasoning",
      name: "Reasoning",
      options: { baseURL: "https://api.example.com/v1" },
      models: {
        model: {
          id: "model",
          name: "Model",
          api: { npm: CUSTOM_PROVIDER_NPM },
          variants: {
            ultra: { reasoningEffort: "ultra" },
            none: {},
            low: { reasoningEffort: "low" },
            max: { reasoningEffort: "max" },
          },
        },
      },
    });
    expect(draft?.models[0]?.reasoningDepths).toEqual(["none", "low", "max", "ultra"]);
  });

  test("does not invent reasoning variants for unknown custom models", () => {
    const config = buildCustomProviderConfig(
      baseInput({ models: [{ id: "acme-chat-v2", name: "Acme Chat V2" }] }),
    );

    expect(config.models?.["acme-chat-v2"]).toEqual({ name: "Acme Chat V2" });
  });

  test("preserves explicitly declared video capabilities without model-name inference", () => {
    const config = buildCustomProviderConfig(baseInput({
      models: [{
        id: "acme-motion",
        name: "Acme Motion",
        mediaGeneration: {
          textToVideo: true,
          outputVideo: { mimeTypes: ["video/mp4"], maxDurationSeconds: 8 },
        },
      }],
    }));

    expect(config.models?.["acme-motion"]).toEqual({
      name: "Acme Motion",
      mediaGeneration: {
        textToVideo: true,
        outputVideo: { mimeTypes: ["video/mp4"], maxDurationSeconds: 8 },
      },
    });
    expect(config.env).toEqual(["CUSTOM_MY_RELAY_API_KEY"]);
  });

  test("derives a non-reserved credential environment key for video adapters", () => {
    expect(customProviderCredentialEnv("Acme.video-gateway")).toBe("CUSTOM_ACME_VIDEO_GATEWAY_API_KEY");
  });

  test("builds a trimmed credential mirror only when both key and value exist", () => {
    expect(customProviderCredentialEnvEntry({ credentialEnv: " ACME_VIDEO_KEY " }, " secret ")).toEqual({
      key: "ACME_VIDEO_KEY",
      value: "secret",
    });
    expect(customProviderCredentialEnvEntry({ credentialEnv: "ACME_VIDEO_KEY" }, "  ")).toBeNull();
    expect(customProviderCredentialEnvEntry({ credentialEnv: null }, "secret")).toBeNull();
  });

  test("marks generation-only models as video output instead of chat models", () => {
    const config = buildCustomProviderConfig(baseInput({
      models: [{
        id: "motion-only",
        name: "Motion only",
        chat: false,
        mediaGeneration: { textToVideo: true, outputVideo: { mimeTypes: ["video/mp4"] } },
      }],
    }));
    expect(config.models?.["motion-only"]).toEqual({
      name: "Motion only",
      modalities: { input: ["text"], output: ["video"] },
      mediaGeneration: { textToVideo: true, outputVideo: { mimeTypes: ["video/mp4"] } },
    });
  });

  test("preserves the per-model Volcengine Ark V3 video protocol", () => {
    const config = buildCustomProviderConfig(baseInput({
      models: [{
        id: "seedance",
        name: "Seedance",
        chat: false,
        mediaGeneration: {
          protocol: "volcengine-ark-v3",
          textToVideo: true,
          outputVideo: { mimeTypes: ["video/mp4"] },
        },
      }],
    }));
    expect(config.models?.seedance?.mediaGeneration).toEqual({
      protocol: "volcengine-ark-v3",
      textToVideo: true,
      outputVideo: { mimeTypes: ["video/mp4"] },
    });
    const draft = customProviderInputFromProvider({
      id: "ark", name: "Ark", env: ["ARK_API_KEY"], options: { baseURL: "https://ark.cn-beijing.volces.com/api/v3" },
      models: { seedance: { id: "seedance", name: "Seedance", api: { npm: CUSTOM_PROVIDER_NPM }, modalities: { input: ["text"], output: ["video"] }, mediaGeneration: config.models?.seedance?.mediaGeneration } },
    });
    expect(draft?.models[0]?.mediaGeneration?.protocol).toBe("volcengine-ark-v3");
  });

  test("preserves the declared credential key and video metadata when editing", () => {
    const draft = customProviderInputFromProvider({
      id: "acme-video",
      name: "Acme Video",
      env: ["ACME_VIDEO_KEY"],
      options: { baseURL: "https://video.example.com/v1" },
      models: {
        motion: {
          id: "motion",
          name: "Motion",
          api: { npm: CUSTOM_PROVIDER_NPM },
          mediaGeneration: {
            textToVideo: true,
            imageToVideo: true,
            inputImage: { mimeTypes: ["image/png"], maxBytes: 5_000_000, maxCount: 1 },
            outputVideo: { mimeTypes: ["video/mp4"], maxDurationSeconds: 10, resolutions: ["720p"] },
          },
        },
      },
    });

    expect(draft?.credentialEnv).toBe("ACME_VIDEO_KEY");
    expect(draft?.models[0]?.mediaGeneration).toEqual({
      textToVideo: true,
      imageToVideo: true,
      inputImage: { mimeTypes: ["image/png"], maxBytes: 5_000_000, maxCount: 1 },
      outputVideo: { mimeTypes: ["video/mp4"], maxDurationSeconds: 10, resolutions: ["720p"] },
    });
  });

  test("preserves different capabilities for each model in one provider", () => {
    const draft = customProviderInputFromProvider({
      id: "mixed-video",
      name: "Mixed Video",
      env: ["MIXED_VIDEO_KEY"],
      options: { baseURL: "https://video.example.com/v1" },
      models: {
        t2v: {
          id: "t2v", name: "T2V", api: { npm: CUSTOM_PROVIDER_NPM },
          mediaGeneration: { textToVideo: true },
        },
        i2v: {
          id: "i2v", name: "I2V", api: { npm: CUSTOM_PROVIDER_NPM },
          mediaGeneration: { imageToVideo: true },
        },
      },
    });
    expect(draft?.models).toEqual([
      { id: "t2v", name: "T2V", mediaGeneration: { textToVideo: true } },
      { id: "i2v", name: "I2V", mediaGeneration: { imageToVideo: true } },
    ]);
  });

  test("keeps text and video models independent in one provider config", () => {
    const config = buildCustomProviderConfig(baseInput({
      models: [
        { id: "chat", name: "Chat" },
        {
          id: "motion",
          name: "Motion",
          chat: false,
          mediaGeneration: { textToVideo: true, outputVideo: { mimeTypes: ["video/mp4"] } },
        },
      ],
    }));
    expect(config.models?.chat).toEqual({ name: "Chat" });
    expect(config.models?.motion).toEqual({
      name: "Motion",
      modalities: { input: ["text"], output: ["video"] },
      mediaGeneration: { textToVideo: true, outputVideo: { mimeTypes: ["video/mp4"] } },
    });
  });

  test("stores text-to-image, image-to-image, and multi-image capabilities per model", () => {
    const config = buildCustomProviderConfig(baseInput({
      models: [{
        id: "image-model",
        name: "Image model",
        chat: false,
        imageGeneration: {
          protocol: "openai",
          textToImage: true,
          imageToImage: true,
          multiImageToImage: true,
          inputImage: { mimeTypes: ["image/png", "image/jpeg", "image/webp"], maxBytes: 25_000_000, maxCount: 16 },
          outputImage: { mimeTypes: ["image/png", "image/jpeg", "image/webp"] },
        },
      }],
    }));
    expect(config.models?.["image-model"]).toEqual({
      name: "Image model",
      modalities: { input: ["text", "image"], output: ["image"] },
      imageGeneration: {
        protocol: "openai",
        textToImage: true,
        imageToImage: true,
        multiImageToImage: true,
        inputImage: { mimeTypes: ["image/png", "image/jpeg", "image/webp"], maxBytes: 25_000_000, maxCount: 16 },
        outputImage: { mimeTypes: ["image/png", "image/jpeg", "image/webp"] },
      },
    });
    const draft = customProviderInputFromProvider({
      id: "images", name: "Images", env: ["IMAGES_KEY"], options: { baseURL: "https://api.example.com/v1" },
      models: { "image-model": { id: "image-model", name: "Image model", api: { npm: CUSTOM_PROVIDER_NPM }, ...(config.models?.["image-model"] ?? {}) } },
    });
    expect(draft?.models[0]?.imageGeneration?.multiImageToImage).toBe(true);
  });

  test("writes independent Chat and Responses adapters for text models", () => {
    const config = buildCustomProviderConfig(baseInput({
      models: [
        { id: "chat-model", name: "Chat model", textProtocol: "chat-completions" },
        { id: "response-model", name: "Response model", textProtocol: "responses" },
      ],
    }));
    expect(config.npm).toBe(CUSTOM_PROVIDER_NPM);
    expect(config.models?.["chat-model"]).toEqual({ name: "Chat model" });
    expect(config.models?.["response-model"]).toEqual({
      name: "Response model",
      provider: { npm: CUSTOM_PROVIDER_RESPONSES_NPM },
    });
  });

  test("round-trips model-level Responses adapter without changing Chat siblings", () => {
    const draft = customProviderInputFromProvider({
      id: "mixed-text",
      name: "Mixed text",
      options: { baseURL: "https://api.example.com/v1" },
      models: {
        chat: { id: "chat", name: "Chat", api: { npm: CUSTOM_PROVIDER_NPM } },
        responses: { id: "responses", name: "Responses", api: { npm: CUSTOM_PROVIDER_RESPONSES_NPM } },
      },
    });
    expect(draft?.models).toEqual([
      { id: "chat", name: "Chat" },
      { id: "responses", name: "Responses", textProtocol: "responses" },
    ]);
  });
});

describe("formatConfigWithCustomProvider", () => {
  test("seeds an empty config with the schema and the provider block", () => {
    const raw = formatConfigWithCustomProvider("", "my-relay", buildCustomProviderConfig(baseInput()));
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.provider).toEqual({
      "my-relay": {
        npm: "@ai-sdk/openai-compatible",
        name: "My Relay",
        options: { baseURL: "https://api.example.com/v1" },
        models: { "gpt-4o": { name: "GPT-4o" } },
      },
    });
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("replaces the same provider on re-add and leaves other providers alone", () => {
    const existing = JSON.stringify(
      {
        provider: {
          other: { npm: "@ai-sdk/openai-compatible", name: "Other" },
          "my-relay": {
            npm: "@ai-sdk/openai-compatible",
            name: "Old",
            options: { baseURL: "https://old.example.com/v1" },
            models: { legacy: { name: "Legacy" } },
          },
        },
      },
      null,
      2,
    );

    const parsed = JSON.parse(
      formatConfigWithCustomProvider("\n" + existing, "my-relay", buildCustomProviderConfig(baseInput())),
    ) as { provider: Record<string, unknown> };

    expect(parsed.provider.other).toEqual({ npm: "@ai-sdk/openai-compatible", name: "Other" });
    expect(parsed.provider["my-relay"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "My Relay",
      options: { baseURL: "https://api.example.com/v1" },
      models: { "gpt-4o": { name: "GPT-4o" } },
    });
  });
});

describe("formatConfigWithoutCustomProvider", () => {
  test("removes the provider and its disabled entry while preserving unrelated config", () => {
    const existing = `{
  // Keep this workspace setting.
  "theme": "dark",
  "provider": {
    "other": { "name": "Other" },
    "my-relay": { "name": "My Relay" }
  },
  "disabled_providers": ["my-relay", "other-disabled"]
}\n`;

    const updated = formatConfigWithoutCustomProvider(existing, "my-relay");
    const parsed = JSON.parse(updated.replace(/\/\/.*$/gm, "")) as {
      theme: string;
      provider: Record<string, unknown>;
      disabled_providers: string[];
    };

    expect(updated).toContain("// Keep this workspace setting.");
    expect(parsed.theme).toBe("dark");
    expect(parsed.provider).toEqual({ other: { name: "Other" } });
    expect(parsed.disabled_providers).toEqual(["other-disabled"]);
  });

  test("removes empty provider and disabled_providers containers", () => {
    const updated = formatConfigWithoutCustomProvider(
      JSON.stringify({ provider: { relay: { name: "Relay" } }, disabled_providers: ["relay"] }),
      "relay",
    );

    expect(JSON.parse(updated)).toEqual({});
  });

  test("treats a missing provider path as an idempotent no-op", () => {
    expect(JSON.parse(formatConfigWithoutCustomProvider("{}\n", "huoshan1"))).toEqual({});
    expect(JSON.parse(formatConfigWithoutCustomProvider('{"theme":"dark"}\n', "huoshan1"))).toEqual({ theme: "dark" });
    expect(JSON.parse(formatConfigWithoutCustomProvider('{"provider":{"other":{"name":"Other"}}}\n', "huoshan1"))).toEqual({
      provider: { other: { name: "Other" } },
    });
  });

  test("removes a disabled entry even when the provider block is absent", () => {
    const updated = formatConfigWithoutCustomProvider(
      JSON.stringify({ disabled_providers: ["huoshan1", "other"] }),
      "huoshan1",
    );
    expect(JSON.parse(updated)).toEqual({ disabled_providers: ["other"] });
  });
});
