declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import {
  isDesktopModelBlocked,
  isDesktopProviderBlocked,
  isProviderHiddenFromConnectUi,
  readDesktopAllowedModels,
  type DesktopAppRestrictionChecker,
} from "./desktop-app-restrictions";

const allowEverything: DesktopAppRestrictionChecker = () => false;
const blockCustomProviders: DesktopAppRestrictionChecker = ({ restriction }) =>
  restriction === "allowCustomProviders";
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
    for (const providerId of ["lpr_01H2X", "LPR_01H2X", "jugglework"]) {
      expect(
        isDesktopProviderBlocked({
          providerId,
          checkRestriction: allowEverything,
          allowedModels: catalog,
        }),
      ).toBe(false);
    }
  });

  test("never hides a provider the user declared in their own OpenCode config", () => {
    expect(
      isDesktopProviderBlocked({
        providerId: "zhipu",
        checkRestriction: allowEverything,
        allowedModels: catalog,
        providerSource: "config",
      }),
    ).toBe(false);
  });

  test("gates locally configured providers on allowCustomProviders", () => {
    expect(
      isDesktopProviderBlocked({
        providerId: "zhipu",
        checkRestriction: blockCustomProviders,
        allowedModels: catalog,
        providerSource: "config",
      }),
    ).toBe(true);
    // Org-published providers land in the runtime config too, but the policy
    // for user-added providers must never hide them.
    expect(
      isDesktopProviderBlocked({
        providerId: "lpr_01H2X",
        checkRestriction: blockCustomProviders,
        allowedModels: catalog,
        providerSource: "config",
      }),
    ).toBe(false);
  });

  test("still applies the catalog to env- and credential-backed providers", () => {
    for (const providerSource of ["env", "api", "custom"] as const) {
      expect(
        isDesktopProviderBlocked({
          providerId: "openrouter",
          checkRestriction: allowEverything,
          allowedModels: catalog,
          providerSource,
        }),
      ).toBe(true);
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

  test("allows every model of a locally configured provider", () => {
    expect(
      isDesktopModelBlocked({
        model: { providerID: "zhipu", modelID: "glm-5.1" },
        checkRestriction: allowEverything,
        allowedModels: catalog,
        providerSource: "config",
      }),
    ).toBe(false);
  });

  test("blocks a locally configured provider's models when allowCustomProviders is off", () => {
    expect(
      isDesktopModelBlocked({
        model: { providerID: "zhipu", modelID: "glm-5.1" },
        checkRestriction: blockCustomProviders,
        allowedModels: catalog,
        providerSource: "config",
      }),
    ).toBe(true);
  });
});

describe("isProviderHiddenFromConnectUi", () => {
  test("hides OpenCode Zen, which the desktop does not offer", () => {
    expect(isProviderHiddenFromConnectUi("opencode")).toBe(true);
    expect(isProviderHiddenFromConnectUi("OpenCode")).toBe(true);
    expect(isProviderHiddenFromConnectUi("  opencode  ")).toBe(true);
  });

  test("hides the built-in cloud provider, which arrives with the account", () => {
    expect(isProviderHiddenFromConnectUi("jugglework")).toBe(true);
    expect(isProviderHiddenFromConnectUi("JuggleWork")).toBe(true);
  });

  test("leaves every provider a user can actually connect", () => {
    for (const providerId of ["openai", "anthropic", "google", "openrouter", "jugglerouter"]) {
      expect(isProviderHiddenFromConnectUi(providerId)).toBe(false);
    }
    // Org-published providers are connected through the cloud path, not hidden.
    expect(isProviderHiddenFromConnectUi("lpr_8384cdb8")).toBe(false);
    expect(isProviderHiddenFromConnectUi("")).toBe(false);
  });
});
