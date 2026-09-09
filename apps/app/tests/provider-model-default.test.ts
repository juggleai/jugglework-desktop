import { describe, expect, test } from "bun:test";

import { resolveConnectedProviderModel } from "../src/react-app/infra/provider-list-query";

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
