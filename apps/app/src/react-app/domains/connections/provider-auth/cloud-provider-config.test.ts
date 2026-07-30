declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import type {
  DenOrgLlmProvider,
  DenOrgLlmProviderModel,
} from "../../../../app/lib/den";
import type { CloudImportedProvider } from "../../../../app/cloud/import-state";
import type { DenOrgLlmProviderConnection } from "../../../../app/lib/den";
import {
  buildCloudProviderConfig,
  CLOUD_PROVIDER_METADATA_VERSION,
  getCloudManagedProviderId,
  getProviderModelIds,
  isCloudProviderOutOfSync,
  missingCloudProviderReloadKey,
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
      },
    },
  };

  const makeJuggleRouter = (
    config: Record<string, unknown>,
  ): DenOrgLlmProviderConnection => ({
    // Den publishes the provider under its own row id; `providerId` is the
    // catalog id, which is what the backfill resolves against.
    id: "lpr_8384",
    source: "models_dev",
    providerId: "jugglerouter",
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
    // The org's own label still wins over the catalog's.
    expect(model?.name).toBe("claude-opus-5");
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
