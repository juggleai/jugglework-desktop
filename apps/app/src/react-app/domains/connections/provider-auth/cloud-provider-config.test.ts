declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import { parse } from "jsonc-parser";

import type {
  DenOrgLlmProvider,
  DenOrgLlmProviderModel,
} from "../../../../app/lib/den";
import type { CloudImportedProvider } from "../../../../app/cloud/import-state";
import type { DenOrgLlmProviderConnection } from "../../../../app/lib/den";
import {
  buildCloudProviderConfig,
  buildCloudImportedProvider,
  buildRuntimeProviderPatch,
  CLOUD_PROVIDER_METADATA_VERSION,
  filterImportableCloudOrgProviders,
  formatConfigWithoutCloudProviders,
  getCurrentCloudManagedProviderIds,
  getCloudManagedProviderId,
  getProviderModelIds,
  isCloudProviderOutOfSync,
  missingCloudProviderReloadKey,
  resolveCloudProviderCredentials,
} from "./cloud-provider-config";
import type { DeploymentModelCatalog } from "./deployment-model-catalog";

const UPDATED_AT = "2024-02-01T00:00:00.000Z";

const makeModel = (id: string): DenOrgLlmProviderModel => ({
  id,
  name: id,
  config: {},
  createdAt: null,
});

const makeProvider = (
  models: DenOrgLlmProviderModel[],
  updatedAt = UPDATED_AT,
): DenOrgLlmProvider => ({
  id: "lpr_openrouter",
  source: "custom",
  providerId: "openrouter",
  name: "OpenRouter",
  providerConfig: {},
  hasApiKey: true,
  models,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt,
});

const importedFrom = (provider: DenOrgLlmProvider): CloudImportedProvider => ({
  cloudProviderId: provider.id,
  providerId: getCloudManagedProviderId(provider),
  sourceProviderId: provider.providerId,
  name: provider.name,
  source: provider.source,
  updatedAt: provider.updatedAt,
  modelIds: getProviderModelIds(provider),
  importedAt: 1,
  metadataVersion: CLOUD_PROVIDER_METADATA_VERSION,
});

describe("getCloudManagedProviderId", () => {
  test("uses the organization provider row id instead of the catalog source id", () => {
    const provider = makeProvider([]);
    expect(getCloudManagedProviderId(provider)).toBe("lpr_openrouter");
  });
});

describe("filterImportableCloudOrgProviders", () => {
  test("keeps managed JuggleRouter but filters hosted and disabled providers", () => {
    const managed = {
      ...makeProvider([makeModel("deepseek-v4-flash")]),
      id: "lpr_managed_router",
      source: "juggle_router" as const,
      providerId: "JuggleRouter",
      managed: true,
      managedKind: "juggle_router" as const,
      accessScope: "organization" as const,
      enabled: true,
    };
    const hosted = {
      ...makeProvider([]),
      id: "lpr_hosted",
      source: "jugglework" as const,
      providerId: "jugglerouter",
    };

    expect(filterImportableCloudOrgProviders([
      hosted,
      { ...hosted, id: "lpr_legacy_hosted", source: "custom", providerId: "JuggleWork" },
      { ...managed, id: "lpr_disabled", enabled: false },
      managed,
    ])).toEqual([managed]);
  });

  test("keeps legacy payloads that do not publish enabled", () => {
    expect(filterImportableCloudOrgProviders([makeProvider([])])).toEqual([makeProvider([])]);
  });
});

describe("getCurrentCloudManagedProviderIds", () => {
  test("does not classify a stale import as cloud without a current organization row", () => {
    const provider = makeProvider([]);
    expect(getCurrentCloudManagedProviderIds({
      imported: { [provider.id]: importedFrom(provider) },
      liveProviders: [],
    })).toEqual([]);
  });

  test("returns the lpr id for a provider published by the current organization", () => {
    const provider = {
      ...makeProvider([]),
      id: "lpr_deepseek",
      providerId: "jugglerouter",
      name: "DeepSeek",
    };
    expect(getCurrentCloudManagedProviderIds({
      imported: { [provider.id]: importedFrom(provider) },
      liveProviders: [provider],
    })).toEqual(["lpr_deepseek"]);
  });
});

describe("isCloudProviderOutOfSync", () => {
  test("returns false for an in-sync provider", () => {
    const provider = makeProvider([makeModel("model-a"), makeModel("model-b")]);
    expect(isCloudProviderOutOfSync(provider, importedFrom(provider))).toBe(false);
  });

  test("ignores whitespace and empty live model ids", () => {
    const baselineProvider = makeProvider([makeModel("model-a")]);
    const liveProvider = makeProvider([
      makeModel("model-a "),
      makeModel("   "),
    ]);

    expect(isCloudProviderOutOfSync(liveProvider, importedFrom(baselineProvider))).toBe(false);
  });

  test("returns true for a changed model list", () => {
    const baselineProvider = makeProvider([makeModel("model-a")]);
    const liveProvider = makeProvider([makeModel("model-a"), makeModel("model-b")]);

    expect(isCloudProviderOutOfSync(liveProvider, importedFrom(baselineProvider))).toBe(true);
  });

  test("returns true for a changed updatedAt", () => {
    const baselineProvider = makeProvider([makeModel("model-a")]);
    const liveProvider = makeProvider(
      [makeModel("model-a")],
      "2024-03-01T00:00:00.000Z",
    );

    expect(isCloudProviderOutOfSync(liveProvider, importedFrom(baselineProvider))).toBe(true);
  });

  test("persists the native source and detects a source migration", () => {
    const provider = {
      ...makeProvider([makeModel("deepseek-v4-flash")]),
      source: "juggle_router" as const,
      providerId: "JuggleRouter",
    };
    const imported = importedFrom(provider);

    expect(imported.source).toBe("juggle_router");
    expect(isCloudProviderOutOfSync(provider, imported)).toBe(false);
    expect(isCloudProviderOutOfSync(
      { ...provider, source: "models_dev" },
      imported,
    )).toBe(true);
  });
});

describe("buildCloudProviderConfig", () => {
  test("keeps an empty models map for a cloud provider without models", () => {
    const provider: DenOrgLlmProviderConnection = {
      id: "lpr_catalog",
      source: "models_dev",
      providerId: "openrouter",
      name: "OpenRouter",
      providerConfig: {
        npm: "@openrouter/ai-sdk-provider",
        api: "https://openrouter.ai/api/v1",
        env: ["OPENROUTER_API_KEY"],
      },
      hasApiKey: true,
      models: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: UPDATED_AT,
      apiKey: "ow_inf_test",
      apiKeys: null,
    };

    const config = buildCloudProviderConfig(provider);
    expect(config.models).toEqual({});
    expect(config.name).toBe("OpenRouter");
  });

  test("keeps an empty models map for non-jugglework cloud providers", () => {
    const provider: DenOrgLlmProviderConnection = {
      id: "lpr_custom",
      source: "custom",
      providerId: "openrouter",
      name: "OpenRouter",
      providerConfig: { env: ["OPENROUTER_API_KEY"] },
      hasApiKey: true,
      models: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: UPDATED_AT,
      apiKey: "sk-test",
      apiKeys: null,
    };

    const config = buildCloudProviderConfig(provider);
    expect(config.models).toEqual({});
  });
});

describe("buildCloudProviderConfig catalog backfill", () => {
  const CATALOG: DeploymentModelCatalog = {
    jugglerouter: {
      "claude-opus-5": {
        limit: { context: 1000000, output: 128000 },
        cost: { input: 5, output: 25 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        family: "claude-opus",
        variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
      },
    },
  };

  const makeJuggleRouter = (
    config: Record<string, unknown>,
  ): DenOrgLlmProviderConnection => ({
    // Den publishes the provider under its own row id; `providerId` is the
    // catalog id, which is what the backfill resolves against.
    id: "lpr_8384",
    source: "juggle_router",
    providerId: "JuggleRouter",
    name: "JuggleRouter",
    providerConfig: { env: ["JUGGLEROUTER_API_KEY"] },
    hasApiKey: true,
    models: [{ id: "claude-opus-5", name: "claude-opus-5", config, createdAt: null }],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: UPDATED_AT,
    apiKey: "sk-test",
    apiKeys: null,
  });

  const modelConfig = (provider: DenOrgLlmProviderConnection, catalog?: DeploymentModelCatalog) =>
    buildCloudProviderConfig(provider, catalog)?.models?.["claude-opus-5"] as
      | Record<string, unknown>
      | undefined;

  test("fills metadata Den did not publish from the deployment catalog", () => {
    const model = modelConfig(makeJuggleRouter({}), CATALOG);
    expect(model?.limit).toEqual({ context: 1000000, output: 128000 });
    expect(model?.cost).toEqual({ input: 5, output: 25 });
    expect(model?.family).toBe("claude-opus");
    expect(model?.variants).toEqual({ low: {}, medium: {}, high: {}, xhigh: {}, max: {} });
    // The org's own label still wins over the catalog's.
    expect(model?.name).toBe("claude-opus-5");
  });

  test("resolves Den's canonical provider casing against the lowercase catalog key", () => {
    const model = modelConfig(makeJuggleRouter({}), CATALOG);
    expect(model?.limit).toEqual({ context: 1000000, output: 128000 });
  });

  test("what the org published wins over the catalog", () => {
    const model = modelConfig(
      makeJuggleRouter({ limit: { context: 200000, output: 64000 } }),
      CATALOG,
    );
    expect(model?.limit).toEqual({ context: 200000, output: 64000 });
    expect(model?.cost).toEqual({ input: 5, output: 25 });
  });

  test("a catalog without the provider leaves the block untouched", () => {
    const model = modelConfig(makeJuggleRouter({}), { openrouter: {} });
    expect(model?.limit).toBe(undefined);
    expect(model).toEqual({ id: "claude-opus-5", name: "claude-opus-5" });
  });

  test("no catalog is the same as before the backfill", () => {
    expect(modelConfig(makeJuggleRouter({}))).toEqual({
      id: "claude-opus-5",
      name: "claude-opus-5",
    });
  });
});

describe("managed JuggleRouter import", () => {
  test("uses the opaque lpr key, canonical identity/models, and gateway projection", () => {
    const gatewayUrl = "https://cloud.example.test/jwork/api/gateway/v1/lpr_router";
    const gatewayToken = "jwgw_desktop_opaque_token";
    const upstreamUrlSentinel = "https://upstream-secret.invalid/v1";
    const upstreamKeySentinel = "upstream-secret-key-must-not-leak";
    const provider: DenOrgLlmProviderConnection = {
      id: "lpr_router",
      source: "juggle_router",
      providerId: "JuggleRouter",
      name: "JuggleRouter",
      providerConfig: {
        npm: "@ai-sdk/openai-compatible",
        api: gatewayUrl,
        env: ["JUGGLEWORK_GATEWAY_KEY_LPR_ROUTER"],
        options: { baseURL: gatewayUrl },
        upstreamBaseURL: upstreamUrlSentinel,
        upstreamApiKey: upstreamKeySentinel,
      },
      hasApiKey: true,
      managed: true,
      managedKind: "juggle_router",
      accessScope: "organization",
      enabled: true,
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          config: {
            family: "deepseek-flash",
            reasoning: true,
            tool_call: true,
            limit: { context: 1000000, output: 384000 },
            cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
            modalities: { input: ["text"], output: ["text"] },
          },
          createdAt: null,
        },
      ],
      createdAt: "2026-08-24T01:02:03Z",
      updatedAt: "2026-08-25T01:02:03Z",
      apiKey: gatewayToken,
      apiKeys: null,
    };

    const patch = buildRuntimeProviderPatch(provider, getCloudManagedProviderId(provider));
    const imported = buildCloudImportedProvider(provider, 123);
    expect(Object.keys(patch)).toEqual(["lpr_router"]);
    expect(patch.lpr_router).toEqual({
      id: "JuggleRouter",
      name: "JuggleRouter",
      env: ["JUGGLEWORK_GATEWAY_KEY_LPR_ROUTER"],
      npm: "@ai-sdk/openai-compatible",
      api: gatewayUrl,
      options: { baseURL: gatewayUrl },
      models: {
        "deepseek-v4-flash": {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          family: "deepseek-flash",
          reasoning: true,
          tool_call: true,
          limit: { context: 1000000, output: 384000 },
          cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    });
    expect(resolveCloudProviderCredentials(provider).primaryApiKey).toBe(
      gatewayToken,
    );
    const persisted = JSON.stringify({ patch, imported });
    expect(persisted.includes(gatewayUrl)).toBe(true);
    expect(persisted.includes(gatewayToken)).toBe(false);
    expect(persisted.includes(upstreamUrlSentinel)).toBe(false);
    expect(persisted.includes(upstreamKeySentinel)).toBe(false);
    expect(imported).toEqual({
      cloudProviderId: "lpr_router",
      providerId: "lpr_router",
      sourceProviderId: "JuggleRouter",
      name: "JuggleRouter",
      source: "juggle_router",
      updatedAt: "2026-08-25T01:02:03Z",
      modelIds: ["deepseek-v4-flash"],
      importedAt: 123,
      metadataVersion: CLOUD_PROVIDER_METADATA_VERSION,
    });
  });

  test("treats disablement as absence and re-enable as a fresh import candidate", () => {
    const provider = {
      ...makeProvider([makeModel("deepseek-v4-flash")]),
      id: "lpr_router",
      source: "juggle_router" as const,
      providerId: "JuggleRouter",
      enabled: true,
    };

    expect(filterImportableCloudOrgProviders([{ ...provider, enabled: false }])).toEqual([]);
    expect(filterImportableCloudOrgProviders([provider])).toEqual([provider]);
  });

  test("absence cleanup removes the legacy block and stale disabled entry", () => {
    const cleaned = formatConfigWithoutCloudProviders(
      `{
        "provider": {
          "lpr_router": { "id": "JuggleRouter" },
          "openai": { "id": "openai" }
        },
        "disabled_providers": ["openai", "lpr_router"]
      }`,
      ["lpr_router"],
    );

    expect(parse(cleaned)).toEqual({
      provider: { openai: { id: "openai" } },
      disabled_providers: ["openai"],
    });
  });

  test("two-id legacy cleanup neither reintroduces an id nor persists merged entries", () => {
    const cleaned = formatConfigWithoutCloudProviders(
      `{
        "provider": {
          "lpr_current": { "id": "JuggleRouter" },
          "lpr_previous": { "id": "JuggleRouter" },
          "openai": { "id": "openai" }
        },
        "disabled_providers": ["project-only", "lpr_current", "LPR_PREVIOUS"]
      }`,
      ["lpr_current", "lpr_previous"],
    );

    expect(parse(cleaned)).toEqual({
      provider: { openai: { id: "openai" } },
      disabled_providers: ["project-only"],
    });
    expect(cleaned.includes("global-only")).toBe(false);
  });
});

describe("missingCloudProviderReloadKey", () => {
  const imported = (ids: string[]): Record<string, CloudImportedProvider> =>
    Object.fromEntries(
      ids.map((id) => [id, importedFrom({ ...makeProvider([makeModel("m")]), id })]),
    );

  test("returns null when the engine knows every imported provider", () => {
    expect(missingCloudProviderReloadKey({
      workspaceId: "ws_1",
      imported: imported(["lpr_a", "lpr_b"]),
      engineProviderIds: ["anthropic", "lpr_b", "lpr_a"],
    })).toBe(null);
  });

  test("returns null when nothing was imported", () => {
    expect(missingCloudProviderReloadKey({
      workspaceId: "ws_1",
      imported: {},
      engineProviderIds: [],
    })).toBe(null);
  });

  test("keys on the workspace and the sorted missing ids", () => {
    // The engine loaded none of them — the reload after the import was dropped.
    expect(missingCloudProviderReloadKey({
      workspaceId: "ws_1",
      imported: imported(["lpr_b", "lpr_a"]),
      engineProviderIds: ["anthropic"],
    })).toBe("ws_1::lpr_a,lpr_b");
  });

  test("is stable across trigger order and whitespace so one gap asks once", () => {
    const first = missingCloudProviderReloadKey({
      workspaceId: "ws_1",
      imported: imported(["lpr_a", "lpr_b"]),
      engineProviderIds: [" anthropic "],
    });
    const repeated = missingCloudProviderReloadKey({
      workspaceId: "ws_1",
      imported: imported(["lpr_b", "lpr_a"]),
      engineProviderIds: ["anthropic"],
    });
    expect(first).toBe(repeated);
  });

  test("reports only the providers the engine is missing", () => {
    expect(missingCloudProviderReloadKey({
      workspaceId: "ws_2",
      imported: imported(["lpr_a", "lpr_b"]),
      engineProviderIds: ["lpr_a"],
    })).toBe("ws_2::lpr_b");
  });

  test("separates workspaces so a per-workspace gap is not suppressed", () => {
    const one = missingCloudProviderReloadKey({
      workspaceId: "ws_1",
      imported: imported(["lpr_a"]),
      engineProviderIds: [],
    });
    const two = missingCloudProviderReloadKey({
      workspaceId: "ws_2",
      imported: imported(["lpr_a"]),
      engineProviderIds: [],
    });
    expect(one).toBe("ws_1::lpr_a");
    expect(two).toBe("ws_2::lpr_a");
  });
});
