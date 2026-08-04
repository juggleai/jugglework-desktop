import { describe, expect, test } from "bun:test";

import { getDenModelCatalogUrl } from "../src/app/lib/den";
import { parseDeploymentModelCatalog } from "../src/react-app/domains/connections/provider-auth/deployment-model-catalog";

describe("getDenModelCatalogUrl", () => {
  const SELF_HOSTED = "https://den.acme.test";

  test("points at the deployment's own catalog", () => {
    // Same URL the engine gets as OPENCODE_MODELS_URL (denModelsCatalogUrl in
    // apps/desktop/electron/runtime.mjs), plus the file the engine fetches.
    expect(getDenModelCatalogUrl(SELF_HOSTED)).toBe(
      "https://den.acme.test/jwork/models/api.json",
    );
  });

  test("accepts a stored base URL that already carries the control plane path", () => {
    for (const baseUrl of [
      `${SELF_HOSTED}/jwork`,
      `${SELF_HOSTED}/jwork/api`,
      `${SELF_HOSTED}/`,
    ]) {
      expect(getDenModelCatalogUrl(baseUrl)).toBe("https://den.acme.test/jwork/models/api.json");
    }
  });

  test("points the hosted client at the hosted deployment catalog", () => {
    expect(getDenModelCatalogUrl("https://work.juggle.im")).toBe(
      "https://work.juggle.im/jwork/models/api.json",
    );
    expect(getDenModelCatalogUrl("https://work.juggle.im/jwork/api")).toBe(
      "https://work.juggle.im/jwork/models/api.json",
    );
  });

  test("returns null for unusable input", () => {
    expect(getDenModelCatalogUrl("")).toBeNull();
    expect(getDenModelCatalogUrl("not a url")).toBeNull();
  });
});

describe("parseDeploymentModelCatalog", () => {
  test("keeps the provider -> model -> metadata shape", () => {
    const catalog = parseDeploymentModelCatalog({
      jugglerouter: {
        id: "jugglerouter",
        models: {
          "claude-opus-5": {
            limit: { context: 1000000, output: 128000 },
            variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
          },
        },
      },
    });

    expect(catalog.jugglerouter?.["claude-opus-5"]).toEqual({
      limit: { context: 1000000, output: 128000 },
      variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
    });
  });

  test("drops entries that cannot carry model metadata", () => {
    const catalog = parseDeploymentModelCatalog({
      "no-models": { id: "no-models" },
      "empty-models": { models: {} },
      "bad-model": { models: { broken: "nope" } },
      unusable: null,
    });

    expect(Object.keys(catalog)).toEqual([]);
  });

  test("tolerates a payload that is not a catalog", () => {
    expect(parseDeploymentModelCatalog(null)).toEqual({});
    expect(parseDeploymentModelCatalog("nope")).toEqual({});
  });
});
