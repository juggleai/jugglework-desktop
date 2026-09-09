declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import type { DenOrgLlmProvider, DenOrgSummary } from "@/app/lib/den";
import {
  autoAdvanceDefaultModel,
  autoAdvanceOrganization,
  buildDefaultModelSelection,
} from "./onboarding-auto-advance";

const org = (id: string): DenOrgSummary => ({
  id,
  name: `Org ${id}`,
  slug: id,
  role: "owner",
});

const model = (id: string, name?: string) => ({
  id,
  name: name ?? id,
  config: {},
  createdAt: null,
});

const provider = (
  id: string,
  models: ReturnType<typeof model>[],
  overrides: Partial<DenOrgLlmProvider> = {},
): DenOrgLlmProvider => ({
  id,
  source: "custom",
  providerId: "openrouter",
  name: "OpenRouter",
  providerConfig: {},
  hasApiKey: true,
  models,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

describe("autoAdvanceOrganization", () => {
  test("adopts the only organization the user belongs to", () => {
    expect(autoAdvanceOrganization([org("a")])?.id).toBe("a");
  });

  test("restores the preferred organization when there are several", () => {
    expect(autoAdvanceOrganization([org("a"), org("b")], "b")?.id).toBe("b");
  });

  test("defaults to the personal organization without a remembered choice", () => {
    expect(autoAdvanceOrganization([
      org("team"),
      { ...org("mine"), kind: "personal" },
    ])?.id).toBe("mine");
  });

  test("uses the first organization defensively when personal is unavailable", () => {
    expect(autoAdvanceOrganization([org("a"), org("b")])?.id).toBe("a");
  });

  test("keeps the picker when the list is empty or unavailable", () => {
    expect(autoAdvanceOrganization([])).toBe(null);
    expect(autoAdvanceOrganization(null)).toBe(null);
    expect(autoAdvanceOrganization(undefined)).toBe(null);
  });
});

describe("autoAdvanceDefaultModel", () => {
  test("adopts one provider offering one model", () => {
    expect(autoAdvanceDefaultModel([
      provider("lpr_a", [model("model-a")]),
    ])).toEqual({
      providerId: "lpr_a",
      modelId: "model-a",
      label: "OpenRouter · model-a",
    });
  });

  test("adopts the first model when a provider offers several models", () => {
    expect(autoAdvanceDefaultModel([
      provider("lpr_a", [model("model-a"), model("model-b")]),
    ])?.modelId).toBe("model-a");
  });

  test("adopts the first model from the first usable provider", () => {
    expect(autoAdvanceDefaultModel([
      provider("lpr_a", [model("model-a")]),
      provider("lpr_b", [model("model-b")]),
    ])?.providerId).toBe("lpr_a");
  });

  test("skips providers without models", () => {
    expect(autoAdvanceDefaultModel([
      provider("lpr_empty", []),
      provider("lpr_b", [model("model-b")]),
    ])).toEqual({
      providerId: "lpr_b",
      modelId: "model-b",
      label: "OpenRouter · model-b",
    });
  });

  test("keeps the step when the only provider has no models", () => {
    // Nothing to set as a default, so the resource list is still worth showing.
    expect(autoAdvanceDefaultModel([provider("lpr_a", [])])).toBe(null);
  });

  test("keeps the step when there are no providers at all", () => {
    expect(autoAdvanceDefaultModel([])).toBe(null);
    expect(autoAdvanceDefaultModel(null)).toBe(null);
  });
});

describe("buildDefaultModelSelection", () => {
  test("matches what the provider card's button sets", () => {
    expect(buildDefaultModelSelection(
      provider("lpr_a", [model("claude-opus-5", "Claude Opus 5")]),
    )).toEqual({
      providerId: "lpr_a",
      modelId: "claude-opus-5",
      label: "OpenRouter · Claude Opus 5",
    });
  });

  test("falls back to the prettified model id when the model has no name", () => {
    expect(buildDefaultModelSelection(
      provider("lpr_a", [{ id: "raw-model", name: "", config: {}, createdAt: null }]),
    )?.label).toBe("OpenRouter · RAW Model");
  });

  test("returns null when the provider is unusable as a default", () => {
    expect(buildDefaultModelSelection(provider("lpr_a", []))).toBe(null);
    expect(buildDefaultModelSelection(provider("   ", [model("m")]))).toBe(null);
  });
});
