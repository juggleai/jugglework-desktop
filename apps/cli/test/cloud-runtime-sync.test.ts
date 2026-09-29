import assert from "node:assert/strict";
import test from "node:test";
import { buildCloudImportedProvider, type CloudProvider, type CloudProviderConnection } from "@jugglework/cloud-provider";
import { parseCliArgs } from "../src/args.js";
import { JuggleWorkApiError, type JuggleWorkApiClient, type RuntimeProviderStatus } from "../src/api.js";
import type { CloudClient } from "../src/cloud-client.js";
import type { CloudProfileStore } from "../src/cloud-profiles.js";
import { importedCloudProviders, synchronizeCloudRuntime } from "../src/cloud-runtime-sync.js";
import type { CliRenderer } from "../src/render.js";

const first: CloudProvider = {
  id: "lpr_first", providerId: "openai-compatible", name: "First", updatedAt: "2026-09-28",
  providerConfig: { env: ["FIRST_KEY"] }, models: [{ id: "model-b", name: "B" }, { id: "model-a", name: "A" }],
};
const second: CloudProvider = {
  id: "lpr_second", providerId: "openai-compatible", name: "Second", updatedAt: "2026-09-28",
  providerConfig: { env: ["SECOND_KEY"] }, models: [{ id: "model-c", name: "C" }],
};

function harness() {
  const calls: string[] = [];
  const imports: Record<string, ReturnType<typeof buildCloudImportedProvider>> = {};
  let organization = "org_one";
  let cloudProviders: CloudProvider[] = [first, second];
  let configuredModel: string | null = null;
  let profile: { token: string; user: { id: string }; organizationId: string } | null = {
    token: "secret-cloud-token", user: { id: "user_1" }, organizationId: "org_one",
  };
  let authenticated = true;
  let availablePoints = 100_000;
  const status = (providerId: string): RuntimeProviderStatus => ({
    providerId, published: null, imported: Boolean(imports[providerId]), loaded: Boolean(imports[providerId]),
    authenticated: Boolean(imports[providerId]) && authenticated, enabled: imports[providerId] ? true : null,
    models: (cloudProviders.find((item) => item.id === providerId)?.models ?? []).map((model) => ({
      id: model.id, published: null, imported: true, loaded: true, authenticated: true, enabled: true, verifiedExecutable: null,
    })),
  });
  const cloud = {
    organizationState: async () => ({ items: [
      { id: "org_one", name: "One", slug: "one" },
      { id: "org_two", name: "Two", slug: "two" },
    ], activeOrgId: organization, activeOrgSlug: null }),
    providers: async () => cloudProviders,
    tenantAccount: async () => ({ availablePoints, reservedPoints: 0 }),
    providerConnection: async (_token: string, _organizationId: string, id: string) => ({
      ...cloudProviders.find((item) => item.id === id)!, apiKey: "secret-provider-key", apiKeys: { [`${id}_KEY`]: "secret-provider-key" },
    } satisfies CloudProviderConnection),
    catalog: async () => ({}),
  } as unknown as CloudClient;
  const store = {
    get: async () => profile,
    rememberedOrganization: async () => organization,
    selectOrganization: async (_origin: string, id: string) => { if (profile) profile = { ...profile, organizationId: id }; },
  } as unknown as CloudProfileStore;
  const api = {
    workspaceConfig: async () => ({ opencode: configuredModel ? { model: configuredModel } : {}, jugglework: { cloudImports: { providers: { ...imports } } } }),
    providerList: async () => ({ connected: ["opencode", ...Object.keys(imports)], default: { opencode: "big-pickle" }, all: [
      { id: "opencode", models: { "big-pickle": { name: "Big Pickle" } } },
      ...cloudProviders.filter((provider) => imports[provider.id]).map((provider) => ({
        id: provider.id, models: Object.fromEntries(provider.models.map((model) => [model.id, { name: model.name }])),
      })),
    ] }),
    providerStatus: async (_workspaceId: string, providerId: string) => status(providerId),
    preflightProviderAuthority: async () => { calls.push("preflight"); return { ok: true }; },
    getCloudProviderImport: async (_workspaceId: string, id: string) => ({ item: imports[id] ?? null }),
    upsertUserEnvironment: async () => { calls.push("environment"); return { ok: true, count: 1 }; },
    setCloudProviderMirror: async (_workspaceId: string, cloudProviderId: string, organizationId: string) => ({ ok: true, mirror: { workspaceId: "ws", organizationId, cloudProviderId, key: `MCP_GATEWAY_KEY_V2_${organizationId}_${cloudProviderId}` } }),
    removeCloudProviderMirror: async () => { calls.push("remove-mirror"); return { ok: true }; },
    removeUserEnvironment: async () => { calls.push("remove-environment"); return { ok: true }; },
    setProviderAuth: async () => { calls.push("auth"); return { ok: true }; },
    removeProviderAuth: async () => { calls.push("remove-auth"); return { ok: true }; },
    patchCloudProviderConfig: async () => { calls.push("config"); return { updatedAt: 1 }; },
    setCloudProviderImport: async (_workspaceId: string, id: string, item: Record<string, unknown>) => {
      calls.push(`import:${id}`);
      imports[id] = item as ReturnType<typeof buildCloudImportedProvider>;
      return { ok: true, item };
    },
    removeCloudProviderImport: async (_workspaceId: string, id: string) => {
      calls.push(`remove:${id}`);
      delete imports[id];
      return { ok: true };
    },
    reloadEngine: async () => { calls.push("reload"); return { ok: true, reloadedAt: 1 }; },
  } as unknown as JuggleWorkApiClient;
  const output: string[] = [];
  const renderer = {
    registerSecretValues: () => {},
    info: (value: string) => output.push(value),
    warn: (value: string) => output.push(value),
  } as unknown as CliRenderer;
  const options = parseCliArgs([]);
  return {
    calls, imports, cloud, store, api, renderer, output, options,
    setOrganization: (value: string) => { organization = value; },
    setProviders: (value: CloudProvider[]) => { cloudProviders = value; },
    setConfiguredModel: (value: string | null) => { configuredModel = value; },
    setSignedOut: () => { profile = null; },
    setAuthenticated: (value: boolean) => { authenticated = value; },
    setAvailablePoints: (value: number) => { availablePoints = value; },
  };
}

test("login startup imports enabled organization providers and chooses its first published usable model", async () => {
  const state = harness();
  const result = await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  assert.equal(result.organizationId, "org_one");
  assert.equal(result.autoModel, "lpr_first/model-b");
  assert.ok(state.output.includes("Organization default model: First/model-b."));
  assert.deepEqual(result.imported, ["lpr_first", "lpr_second"]);
  assert.deepEqual(state.calls.filter((call) => call === "reload"), ["reload", "reload"]);
  assert.equal(state.imports.lpr_first?.modelIds.length, 2);
  assert.doesNotMatch(state.output.join(" "), /secret-cloud-token|secret-provider-key/);
});

test("unchanged providers are not re-imported and an explicit model remains selected", async () => {
  const state = harness();
  await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  state.calls.length = 0;
  state.options.model = "openai/my-model";
  const result = await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  assert.equal(result.autoModel, null);
  assert.deepEqual(result.imported, []);
  assert.deepEqual(state.calls, ["preflight"]);
});

test("organization switch removes stale credentials and picks the new organization's model", async () => {
  const state = harness();
  await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  state.calls.length = 0;
  state.setOrganization("org_two");
  state.setProviders([{ ...second, id: "lpr_third" }]);
  const result = await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  assert.deepEqual(result.removed.sort(), ["lpr_first", "lpr_second"]);
  assert.deepEqual(result.imported, ["lpr_third"]);
  assert.equal(result.autoModel, "lpr_third/model-c");
  assert.ok(state.calls.includes("remove-auth"));
});

test("same cloud row is reimported when organization ownership changes", async () => {
  const state = harness();
  await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  state.calls.length = 0;
  state.setOrganization("org_two");
  const result = await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  assert.deepEqual(result.imported, ["lpr_first", "lpr_second"]);
  assert.equal(state.imports.lpr_first?.organizationId, "org_two");
  assert.equal(state.calls.filter((call) => call === "remove-mirror").length, 2);
});

test("managed organization balance replaces an unaffordable workspace default", async () => {
  const state = harness();
  const managed: CloudProvider = {
    id: "lpr_router", providerId: "JuggleRouter", name: "JuggleRouter", source: "juggle_router",
    providerConfig: { env: ["JUGGLEWORK_GATEWAY_KEY_V2_TEST"] },
    models: [
      { id: "expensive", name: "Expensive", config: { limit: { context: 1_000_000, output: 100_000 }, cost_metadata: { source_currency: "CNY", source_cost: { input: 8, output: 2 } } } },
      { id: "affordable", name: "Affordable", config: { limit: { context: 1_000_000, output: 100_000 }, cost_metadata: { source_currency: "CNY", source_cost: { input: 1, output: 1 } } } },
    ],
  };
  state.setProviders([managed]);
  state.setConfiguredModel("lpr_router/expensive");
  state.setAvailablePoints(700);
  const result = await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  assert.equal(result.autoModel, "lpr_router/affordable");
  assert.ok(state.output.some((line) => line.includes("requires at least 820 points") && line.includes("has 700")));
});

test("a configured non-Cloud model is preserved, while stale managed defaults are overridden for the CLI session", async () => {
  const state = harness();
  state.setConfiguredModel("local/model");
  assert.equal((await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } })).autoModel, null);
  state.setConfiguredModel("lpr_old/model");
  assert.equal((await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } })).autoModel, "lpr_first/model-b");
});

test("an explicit model from a removed organization is replaced with the new organization's model", async () => {
  const state = harness();
  await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  state.options.model = "lpr_first/model-b";
  state.setOrganization("org_two");
  state.setProviders([{ ...second, id: "lpr_third" }]);
  const result = await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  assert.equal(state.options.model, null);
  assert.equal(result.autoModel, "lpr_third/model-c");
});

test("signed-out owned runtime removes imported Cloud credentials, but a connected runtime is untouched", async () => {
  const state = harness();
  await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } });
  state.setSignedOut();
  state.calls.length = 0;
  assert.deepEqual((await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" }, ownedRuntime: false })).removed, []);
  assert.equal(state.calls.length, 0);
  assert.deepEqual((await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" }, ownedRuntime: true })).removed, ["lpr_first", "lpr_second"]);
  assert.ok(state.calls.includes("remove-auth"));
});

test("published models without a connected credential fail instead of silently using the online default", async () => {
  const state = harness();
  state.setAuthenticated(false);
  await assert.rejects(synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } }), /none are connected and usable/);
});

test("connected runtime without host authority fails before retrieving organization provider credentials", async () => {
  const state = harness();
  const api = {
    ...state.api,
    preflightProviderAuthority: async () => { throw new JuggleWorkApiError("Forbidden", 403, "forbidden"); },
  } as unknown as JuggleWorkApiClient;
  await assert.rejects(synchronizeCloudRuntime({ ...state, api, workspace: { id: "ws" }, ownedRuntime: false }), /--host-token/);
  assert.equal(state.calls.length, 0);
});

test("an organization with no enabled importable providers leaves the existing runtime model alone", async () => {
  const state = harness();
  state.setProviders([]);
  assert.equal((await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } })).autoModel, null);
  assert.equal(state.calls.length, 0);
});

test("temporary Cloud tokens never persist provider credentials", async () => {
  const state = harness();
  state.options.cloudToken = "temporary";
  assert.equal((await synchronizeCloudRuntime({ ...state, workspace: { id: "ws" } })).autoModel, null);
  assert.deepEqual(state.calls, []);
});

test("import inventory parser ignores malformed and non-Cloud entries", () => {
  const baseline = buildCloudImportedProvider(first, 1);
  assert.deepEqual(importedCloudProviders({ jugglework: { cloudImports: { providers: {
    lpr_first: baseline,
    local: { cloudProviderId: "local", providerId: "openai", modelIds: [] },
    broken: { cloudProviderId: "lpr_bad", providerId: "lpr_bad" },
  } } } }), { lpr_first: baseline });
});
