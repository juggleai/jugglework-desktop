import { describe, expect, test } from "bun:test";

import { readStoredDefaultModel, rememberModelVariant } from "../src/react-app/kernel/model-config";

const originalWindow = globalThis.window;

describe("remembered model behavior", () => {
  test("does not invent a hard-coded model on a clean profile", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { getItem: () => null } },
    });
    expect(readStoredDefaultModel()).toBeNull();
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  });
  test("stores the active session model with the selected reasoning strength", () => {
    const previous = {
      defaultModel: { providerID: "old", modelID: "old-model" },
      modelVariant: "low",
      untouched: true,
    };
    expect(rememberModelVariant(
      previous,
      { providerID: "openai", modelID: "gpt-5" },
      "high",
    )).toEqual({
      defaultModel: { providerID: "openai", modelID: "gpt-5" },
      modelVariant: "high",
      untouched: true,
    });
  });

  test("normalizes provider-default aliases to an unset variant", () => {
    expect(rememberModelVariant({ defaultModel: null, modelVariant: "high" }, null, "default"))
      .toEqual({ defaultModel: null, modelVariant: null });
  });
});
