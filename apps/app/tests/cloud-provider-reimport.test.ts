import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DenOrgLlmProviderConnection,
  DenOrgLlmProviderModel,
} from "../src/app/lib/den";
import type { CloudImportedProvider } from "../src/app/cloud/import-state";
import {
  readWorkspaceCloudImports,
  withWorkspaceCloudImports,
} from "../src/app/cloud/import-state";
import {
  buildRuntimeProviderPatch,
  CLOUD_PROVIDER_METADATA_VERSION,
  getCloudManagedProviderId,
  getProviderModelIds,
  isCloudManagedProviderKey,
  isCloudProviderOutOfSync,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

const LPR_ID = "lpr_openrouter";

const providerAuthStoreSourcePath = join(
  import.meta.dir,
  "..",
  "src",
  "react-app",
  "domains",
  "connections",
  "provider-auth",
  "store.ts",
);

const makeModel = (id: string, name = id): DenOrgLlmProviderModel => ({
  id,
  name,
  config: {},
  createdAt: null,
});

const makeProvider = (
  models: DenOrgLlmProviderModel[],
  updatedAt: string,
): DenOrgLlmProviderConnection => ({
  id: LPR_ID,
  source: "custom",
  providerId: "openrouter",
  name: "OpenRouter",
  providerConfig: {
    id: "openrouter",
    name: "OpenRouter",
    npm: "@ai-sdk/openai-compatible",
    env: ["OPENROUTER_API_KEY"],
    api: "https://openrouter.ai/api/v1",
    models: {},
  },
  hasApiKey: true,
  models,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt,
  apiKey: "sk-test",
  apiKeys: null,
});

const importedFrom = (
  provider: DenOrgLlmProviderConnection,
): CloudImportedProvider => ({
  cloudProviderId: provider.id,
  providerId: getCloudManagedProviderId(provider),
  sourceProviderId: provider.providerId,
  name: provider.name,
  source: provider.source,
  updatedAt: provider.updatedAt,
  modelIds: getProviderModelIds(provider),
  importedAt: Date.now(),
  metadataVersion: CLOUD_PROVIDER_METADATA_VERSION,
});

const patchModelKeys = (patch: Record<string, unknown>): string[] => {
  const block = patch[LPR_ID] as { models?: Record<string, unknown> } | null | undefined;
  return block?.models ? Object.keys(block.models).sort() : [];
};

describe("cloud provider runtime patch (re-import diff #2346)", () => {
  test("first import upserts the lpr_* entry with the initial model", () => {
    const provider = makeProvider([makeModel("model-x")], "2024-02-01T00:00:00.000Z");
    const patch = buildRuntimeProviderPatch(provider, LPR_ID);
    expect(Object.keys(patch)).toEqual([LPR_ID]);
    expect(patchModelKeys(patch)).toEqual(["model-x"]);
  });

  test("re-import replaces the entry wholesale (adds and drops models)", () => {
    const updated = makeProvider(
      [makeModel("model-x"), makeModel("model-y")],
      "2024-03-01T00:00:00.000Z",
    );
    expect(patchModelKeys(buildRuntimeProviderPatch(updated, LPR_ID, LPR_ID))).toEqual([
      "model-x",
      "model-y",
    ]);

    const onlyY = makeProvider([makeModel("model-y")], "2024-04-01T00:00:00.000Z");
    expect(patchModelKeys(buildRuntimeProviderPatch(onlyY, LPR_ID, LPR_ID))).toEqual(["model-y"]);
  });

  test("a renamed provider id deletes the predecessor entry", () => {
    const provider = makeProvider([makeModel("model-x")], "2024-03-01T00:00:00.000Z");
    const patch = buildRuntimeProviderPatch(provider, LPR_ID, "lpr_previous");
    expect(patch["lpr_previous"]).toBeNull();
    expect(patchModelKeys(patch)).toEqual(["model-x"]);
  });

  test("cloud-managed key predicate guards re-import vs manual clobber", () => {
    expect(isCloudManagedProviderKey(LPR_ID)).toBe(true);
    expect(isCloudManagedProviderKey("lpr_anything")).toBe(true);
    expect(isCloudManagedProviderKey("jugglework")).toBe(true);
    expect(isCloudManagedProviderKey("openai")).toBe(false);
    expect(isCloudManagedProviderKey("anthropic")).toBe(false);
  });

  test("out-of-sync detection flags a changed Den model list", () => {
    const first = makeProvider([makeModel("model-x")], "2024-02-01T00:00:00.000Z");
    const baseline = importedFrom(first);

    // Same payload -> in sync.
    expect(isCloudProviderOutOfSync(first, baseline)).toBe(false);

    // Den adds a model -> out of sync (drives the Sync/Import action).
    const updated = makeProvider(
      [makeModel("model-x"), makeModel("model-y")],
      "2024-03-01T00:00:00.000Z",
    );
    expect(isCloudProviderOutOfSync(updated, baseline)).toBe(true);

    // After re-import the baseline advances -> in sync again.
    expect(isCloudProviderOutOfSync(updated, importedFrom(updated))).toBe(false);
  });

  test("persists the native managed source through workspace import state", () => {
    const provider = {
      ...makeProvider(
        [makeModel("deepseek-v4-flash", "DeepSeek V4 Flash")],
        "2026-08-25T01:02:03.000Z",
      ),
      id: "lpr_3f8d77482bd4da3bdc4ae54f79d749c28ee5bde7",
      source: "juggle_router" as const,
      providerId: "JuggleRouter",
      name: "JuggleRouter",
    };
    const imported = importedFrom(provider);
    const persisted = JSON.parse(JSON.stringify(withWorkspaceCloudImports({}, {
      providers: { [provider.id]: imported },
      marketplaces: {},
      plugins: {},
    })));
    const restored = readWorkspaceCloudImports(persisted).providers[provider.id];

    expect(restored?.source).toBe("juggle_router");
    expect(restored?.providerId).toBe(provider.id);
    expect(restored?.sourceProviderId).toBe("JuggleRouter");
    expect(isCloudProviderOutOfSync(provider, restored!)).toBe(false);
  });

  test("a baseline written before catalog backfill is rewritten once", () => {
    const provider = makeProvider([makeModel("model-x")], "2024-02-01T00:00:00.000Z");

    // Den published nothing new — only the shape the desktop writes changed,
    // so without the version stamp the stale block would never be replaced.
    expect(isCloudProviderOutOfSync(provider, { ...importedFrom(provider), metadataVersion: null }))
      .toBe(true);
    expect(isCloudProviderOutOfSync(provider, importedFrom(provider))).toBe(false);
  });

  test("provider baseline persistence does not refresh the desktop cloud snapshot", () => {
    const source = readFileSync(providerAuthStoreSourcePath, "utf8");
    const persistStart = source.indexOf("const persistImportedCloudProviders = async");
    const persistEnd = source.indexOf("const readProjectConfigFile", persistStart);
    expect(persistStart).toBeGreaterThanOrEqual(0);
    expect(persistEnd).toBeGreaterThan(persistStart);

    const persistSource = source.slice(persistStart, persistEnd);
    expect(persistSource).toContain("const config = await readWorkspaceJuggleWorkConfigRecord();");
    expect(persistSource).toContain("const cloudImports = readWorkspaceCloudImports(config);");
    expect(persistSource).toContain("const nextConfig = withWorkspaceCloudImports(config");
    expect(persistSource).toContain("const persisted = await writeWorkspaceJuggleWorkConfigRecord(nextConfig);");
    expect(persistSource).toContain('setStateField("importedCloudProviders", nextProviders);');
    expect(source).not.toContain("refreshDesktop" + "CloudSync");
    expect(source).not.toContain("getResource" + "Snapshot");
  });

  test("absence cleanup funnels through full cloud removal before re-enable import", () => {
    const source = readFileSync(providerAuthStoreSourcePath, "utf8");
    const removeStart = source.indexOf("async function removeCloudProviderInternal");
    const removeEnd = source.indexOf("async function removeCloudProvider(", removeStart);
    const removeSource = source.slice(removeStart, removeEnd);

    expect(removeSource).toContain("await removeGatewayMirror(");
    expect(removeSource).toContain("cloudProviderId,");
    expect(removeSource).toContain("await removeProviderAuthCredentials(imported.providerId);");
    expect(removeSource).toContain("await patchRuntimeProviders({ [imported.providerId]: null });");
    expect(removeSource).toContain("await removeCloudProviderDisabledState([");
    expect(removeSource).toContain("delete nextImportedProviders[cloudProviderId];");
    expect(source).toContain("if (!liveProvider) {");
    expect(source).toContain("await removeCloudProviderInternal(importedProvider.cloudProviderId, { silent: true });");
    expect(source).toContain("await connectCloudProviderInternal(liveProvider.id, { silent: true });");
  });
});
