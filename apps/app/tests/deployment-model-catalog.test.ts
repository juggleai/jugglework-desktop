import { describe, expect, test } from "bun:test";

import { getDenModelCatalogUrl } from "../src/app/lib/den";
import { parseDeploymentModelCatalog } from "../src/react-app/domains/connections/provider-auth/deployment-model-catalog";

describe("getDenModelCatalogUrl", () => {
  test("points at the deployment's own catalog", () => {
    // Same URL the engine gets as OPENCODE_MODELS_URL (denModelsCatalogUrl in
    // apps/desktop/electron/runtime.mjs), plus the file the engine fetches.
    expect(getDenModelCatalogUrl("https://work.juggle.im")).toBe(
      "https://work.juggle.im/jwork/models/api.json",
    );
  });

  test("accepts a stored base URL that already carries the control plane path", () => {
    for (const baseUrl of [
      "https://work.juggle.im/jwork",
      "https://work.juggle.im/jwork/api",
      "https://work.juggle.im/",
    ]) {
      expect(getDenModelCatalogUrl(baseUrl)).toBe("https://work.juggle.im/jwork/models/api.json");
    }
  });

  test("returns null where there is no private catalog to read", () => {
    // The hosted cloud serves no deployment catalog, and an unusable value
    // must not become a URL — both leave imports on Den's metadata alone.
    expect(getDenModelCatalogUrl("https://work.juggle.im")).toBeNull();
    expect(getDenModelCatalogUrl("https://work.juggle.im/jwork/api")).toBeNull();
    expect(getDenModelCatalogUrl("")).toBeNull();
    expect(getDenModelCatalogUrl("not a url")).toBeNull();
  });
});

describe("parseDeploymentModelCatalog", () => {
  test("keeps the provider -> model -> metadata shape", () => {
    const catalog = parseDeploymentModelCatalog({
      jugglerouter: {
        id: "jugglerouter",
        models: { "claude-opus-5": { limit: { context: 1000000, output: 128000 } } },
      },
    });

    expect(catalog.jugglerouter?.["claude-opus-5"]).toEqual({
      limit: { context: 1000000, output: 128000 },
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
