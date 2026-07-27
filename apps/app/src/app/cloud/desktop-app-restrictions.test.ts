declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import {
  isDesktopModelBlocked,
  isDesktopProviderBlocked,
  readDesktopAllowedModels,
  type DesktopAppRestrictionChecker,
} from "./desktop-app-restrictions";

const allowEverything: DesktopAppRestrictionChecker = () => false;
const catalog = ["anthropic/claude-opus-4-8", "openai/gpt-5.6-terra", "jugglerouter/claude-opus-5"];

describe("readDesktopAllowedModels", () => {
  test("treats a missing policy as unrestricted", () => {
    expect(readDesktopAllowedModels(null)).toEqual([]);
    expect(readDesktopAllowedModels({})).toEqual([]);
  });
});

describe("isDesktopProviderBlocked", () => {
  test("allows anything when the cloud sends no catalog", () => {
    expect(
      isDesktopProviderBlocked({ providerId: "openrouter", checkRestriction: allowEverything }),
    ).toBe(false);
    expect(
      isDesktopProviderBlocked({
        providerId: "openrouter",
        checkRestriction: allowEverything,
        allowedModels: [],
      }),
    ).toBe(false);
  });

  test("blocks providers the catalog does not list", () => {
    expect(
      isDesktopProviderBlocked({
        providerId: "openrouter",
        checkRestriction: allowEverything,
        allowedModels: catalog,
      }),
    ).toBe(true);
    expect(
      isDesktopProviderBlocked({
        providerId: "anthropic",
        checkRestriction: allowEverything,
        allowedModels: catalog,
      }),
    ).toBe(false);
  });

  test("never hides providers the org itself published", () => {
    for (const providerId of ["lpr_01H2X", "LPR_01H2X", "openwork"]) {
      expect(
        isDesktopProviderBlocked({
          providerId,
          checkRestriction: allowEverything,
          allowedModels: catalog,
        }),
      ).toBe(false);
    }
  });

  test("still honours the allowZenModel policy", () => {
    expect(
      isDesktopProviderBlocked({
        providerId: "opencode",
        checkRestriction: ({ restriction }) => restriction === "allowZenModel",
      }),
    ).toBe(true);
  });
});

describe("isDesktopModelBlocked", () => {
  test("blocks a model the catalog omits even when the provider is allowed", () => {
    expect(
      isDesktopModelBlocked({
        model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
        checkRestriction: allowEverything,
        allowedModels: catalog,
      }),
    ).toBe(false);
    expect(
      isDesktopModelBlocked({
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
        checkRestriction: allowEverything,
        allowedModels: catalog,
      }),
    ).toBe(true);
  });

  test("allows every model of an org-published provider", () => {
    expect(
      isDesktopModelBlocked({
        model: { providerID: "lpr_01H2X", modelID: "anything" },
        checkRestriction: allowEverything,
        allowedModels: catalog,
      }),
    ).toBe(false);
  });
});
