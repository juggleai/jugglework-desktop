import { describe, expect, test } from "bun:test";

import en from "../src/i18n/locales/en";
import zh from "../src/i18n/locales/zh";
import {
  buildCustomProviderConfig,
  formatConfigWithCustomProvider,
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

describe("normalizeCustomProviderId", () => {
  test("folds a display name into a config-safe key", () => {
    expect(normalizeCustomProviderId("  My Relay 中转 ")).toBe("my-relay");
    expect(normalizeCustomProviderId("Foo//Bar")).toBe("foo-bar");
    expect(normalizeCustomProviderId("--edge--")).toBe("edge");
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
